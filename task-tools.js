const { parseDateKey } = require("./read-tools");

const TASK_FIELDS = "id, title, note, deadline, priority, done, created_at, completed_at";
const PRIORITIES = new Set(["low", "medium", "high"]);
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function throwIfError(error, operation) {
  if (error) {
    const wrapped = new Error(`Planner ${operation} failed`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function validateTaskId(taskId) {
  if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
    throw new TypeError("task_id must be a valid UUID");
  }
}

function validateTitle(title) {
  if (typeof title !== "string" || !title.trim()) {
    throw new TypeError("title must be a non-empty string");
  }
  if (title.trim().length > 500) {
    throw new TypeError("title must be 500 characters or fewer");
  }
  return title.trim();
}

function validateNote(note) {
  if (note !== null && typeof note !== "string") {
    throw new TypeError("note must be a string or null");
  }
  return typeof note === "string" ? note.trim() || null : null;
}

function validateDeadline(deadline) {
  return deadline === null ? null : parseDateKey(deadline, "deadline");
}

function validatePriority(priority) {
  if (!PRIORITIES.has(priority)) {
    throw new TypeError("priority must be low, medium, or high");
  }
  return priority;
}

function createTaskTools({ supabase, now = () => new Date() }) {
  async function resolveUserId(ctx) {
    const telegramId = ctx?.from?.id;
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
      throw new TypeError("A valid Telegram context is required");
    }

    const { data, error } = await supabase
      .from("telegram_users")
      .select("supabase_user_id")
      .eq("telegram_id", telegramId)
      .maybeSingle();

    throwIfError(error, "Telegram link lookup");
    if (!data?.supabase_user_id) {
      const notLinked = new Error("Telegram account is not linked to Planner");
      notLinked.code = "TELEGRAM_NOT_LINKED";
      throw notLinked;
    }
    return data.supabase_user_id;
  }

  async function findTask(userId, taskId) {
    const { data, error } = await supabase
      .from("tasks")
      .select(TASK_FIELDS)
      .eq("id", taskId)
      .eq("user_id", userId)
      .maybeSingle();

    throwIfError(error, "task lookup");
    return data;
  }

  async function create_task(ctx, args = {}) {
    const allowed = new Set(["title", "note", "deadline", "priority"]);
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) throw new TypeError(`Unsupported task field: ${key}`);
    }

    const title = validateTitle(args.title);
    const note = args.note === undefined ? null : validateNote(args.note);
    const deadline = args.deadline === undefined || args.deadline === ""
      ? null
      : validateDeadline(args.deadline);
    const priority = args.priority === undefined
      ? "medium"
      : validatePriority(args.priority);
    const userId = await resolveUserId(ctx);

    const { data, error } = await supabase
      .from("tasks")
      .insert({ title, note, deadline, priority, done: false, completed_at: null, user_id: userId })
      .select(TASK_FIELDS)
      .single();

    throwIfError(error, "task creation");
    return { created: true, task: data };
  }

  async function update_task(ctx, args = {}) {
    const allowed = new Set(["task_id", "title", "note", "deadline", "priority"]);
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) throw new TypeError(`Unsupported task field: ${key}`);
    }
    validateTaskId(args.task_id);

    const patch = {};
    if (Object.hasOwn(args, "title")) patch.title = validateTitle(args.title);
    if (Object.hasOwn(args, "note")) patch.note = validateNote(args.note);
    if (Object.hasOwn(args, "deadline")) {
      patch.deadline = args.deadline === "" ? null : validateDeadline(args.deadline);
    }
    if (Object.hasOwn(args, "priority")) patch.priority = validatePriority(args.priority);
    if (Object.keys(patch).length === 0) {
      throw new TypeError("At least one task field must be provided");
    }

    const userId = await resolveUserId(ctx);
    const { data, error } = await supabase
      .from("tasks")
      .update(patch)
      .eq("id", args.task_id)
      .eq("user_id", userId)
      .select(TASK_FIELDS)
      .maybeSingle();

    throwIfError(error, "task update");
    if (!data) {
      const notFound = new Error("Task not found for this Planner account");
      notFound.code = "TASK_NOT_FOUND";
      throw notFound;
    }
    return { updated: true, task: data };
  }

  async function complete_task(ctx, { task_id } = {}) {
    validateTaskId(task_id);
    const userId = await resolveUserId(ctx);
    const existing = await findTask(userId, task_id);
    if (!existing) {
      const notFound = new Error("Task not found for this Planner account");
      notFound.code = "TASK_NOT_FOUND";
      throw notFound;
    }
    if (existing.done) return { completed: true, already_completed: true, task: existing };

    const { data, error } = await supabase
      .from("tasks")
      .update({ done: true, completed_at: now().toISOString() })
      .eq("id", task_id)
      .eq("user_id", userId)
      .eq("done", false)
      .select(TASK_FIELDS)
      .maybeSingle();

    throwIfError(error, "task completion");
    if (data) return { completed: true, already_completed: false, task: data };

    // Another request may have completed the same task concurrently.
    const current = await findTask(userId, task_id);
    if (current?.done) return { completed: true, already_completed: true, task: current };
    const notFound = new Error("Task not found for this Planner account");
    notFound.code = "TASK_NOT_FOUND";
    throw notFound;
  }

  async function delete_task(ctx, { task_id } = {}) {
    validateTaskId(task_id);
    const userId = await resolveUserId(ctx);
    const { data, error } = await supabase
      .from("tasks")
      .delete()
      .eq("id", task_id)
      .eq("user_id", userId)
      .select("id, title")
      .maybeSingle();

    throwIfError(error, "task deletion");
    if (!data) {
      const notFound = new Error("Task not found for this Planner account");
      notFound.code = "TASK_NOT_FOUND";
      throw notFound;
    }
    return { deleted: true, task: data };
  }

  return { create_task, update_task, complete_task, delete_task };
}

module.exports = { createTaskTools };
