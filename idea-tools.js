const IDEA_FIELDS = "id, title, category, archived, created_at";
const IDEA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function throwIfError(error, operation) {
  if (error) {
    const wrapped = new Error(`Planner ${operation} failed`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function validateIdeaId(ideaId) {
  if (typeof ideaId !== "string" || !IDEA_ID_PATTERN.test(ideaId)) {
    throw new TypeError("idea_id must be a valid UUID");
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

function validateCategory(category) {
  if (category !== null && typeof category !== "string") {
    throw new TypeError("category must be a string or null");
  }
  return typeof category === "string" ? category.trim() || null : null;
}

function createIdeaTools({ supabase }) {
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

  async function findOwnedIdea(userId, ideaId) {
    const { data, error } = await supabase
      .from("ideas")
      .select(IDEA_FIELDS)
      .eq("id", ideaId)
      .eq("user_id", userId)
      .maybeSingle();

    throwIfError(error, "idea lookup");
    return data;
  }

  async function create_idea(ctx, args = {}) {
    for (const key of Object.keys(args)) {
      if (!["title", "category"].includes(key)) {
        throw new TypeError(`Unsupported idea field: ${key}`);
      }
    }
    const { title, category = null } = args;
    const cleanTitle = validateTitle(title);
    const cleanCategory = validateCategory(category);
    const userId = await resolveUserId(ctx);
    const { data, error } = await supabase
      .from("ideas")
      .insert({
        title: cleanTitle,
        category: cleanCategory,
        archived: false,
        user_id: userId,
      })
      .select(IDEA_FIELDS)
      .single();

    throwIfError(error, "idea creation");
    return { created: true, idea: data };
  }

  async function get_ideas(ctx, { include_archived = false } = {}) {
    if (typeof include_archived !== "boolean") {
      throw new TypeError("include_archived must be a boolean");
    }
    const userId = await resolveUserId(ctx);
    let query = supabase
      .from("ideas")
      .select(IDEA_FIELDS)
      .eq("user_id", userId);
    if (!include_archived) query = query.eq("archived", false);

    const { data, error } = await query.order("created_at", { ascending: false });
    throwIfError(error, "ideas query");
    return { ideas: data || [], include_archived };
  }

  async function update_idea(ctx, args = {}) {
    const allowed = new Set(["idea_id", "title", "category"]);
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) throw new TypeError(`Unsupported idea field: ${key}`);
    }
    validateIdeaId(args.idea_id);

    const patch = {};
    if (Object.hasOwn(args, "title")) patch.title = validateTitle(args.title);
    if (Object.hasOwn(args, "category")) patch.category = validateCategory(args.category);
    if (!Object.keys(patch).length) throw new TypeError("At least one idea field must be provided");

    const userId = await resolveUserId(ctx);
    const { data, error } = await supabase
      .from("ideas")
      .update(patch)
      .eq("id", args.idea_id)
      .eq("user_id", userId)
      .select(IDEA_FIELDS)
      .maybeSingle();

    throwIfError(error, "idea update");
    if (!data) {
      const notFound = new Error("Idea not found for this Planner account");
      notFound.code = "IDEA_NOT_FOUND";
      throw notFound;
    }
    return { updated: true, idea: data };
  }

  async function delete_idea(ctx, { idea_id } = {}) {
    validateIdeaId(idea_id);
    const userId = await resolveUserId(ctx);
    const { data, error } = await supabase
      .from("ideas")
      .delete()
      .eq("id", idea_id)
      .eq("user_id", userId)
      .select("id, title")
      .maybeSingle();

    throwIfError(error, "idea deletion");
    if (!data) {
      const notFound = new Error("Idea not found for this Planner account");
      notFound.code = "IDEA_NOT_FOUND";
      throw notFound;
    }
    return { deleted: true, idea: data };
  }

  async function archive_idea(ctx, { idea_id, archived = true } = {}) {
    validateIdeaId(idea_id);
    if (typeof archived !== "boolean") throw new TypeError("archived must be a boolean");

    const userId = await resolveUserId(ctx);
    const existing = await findOwnedIdea(userId, idea_id);
    if (!existing) {
      const notFound = new Error("Idea not found for this Planner account");
      notFound.code = "IDEA_NOT_FOUND";
      throw notFound;
    }
    if (existing.archived === archived) {
      return { archived, already_in_requested_state: true, idea: existing };
    }

    const { data, error } = await supabase
      .from("ideas")
      .update({ archived })
      .eq("id", idea_id)
      .eq("user_id", userId)
      .select(IDEA_FIELDS)
      .maybeSingle();

    throwIfError(error, "idea archive update");
    if (!data) {
      const notFound = new Error("Idea not found for this Planner account");
      notFound.code = "IDEA_NOT_FOUND";
      throw notFound;
    }
    return { archived, already_in_requested_state: false, idea: data };
  }

  return { create_idea, get_ideas, update_idea, delete_idea, archive_idea };
}

module.exports = { createIdeaTools };
