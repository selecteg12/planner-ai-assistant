const { dateKeyInZone, parseDateKey } = require("./read-tools");

const HABIT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function throwIfError(error, operation) {
  if (error) {
    const wrapped = new Error(`Planner ${operation} failed`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function validateHabitId(habitId) {
  if (typeof habitId !== "string" || !HABIT_ID_PATTERN.test(habitId)) {
    throw new TypeError("habit_id must be a valid UUID");
  }
}

function createHabitTools({
  supabase,
  timeZone = process.env.PLANNER_TIMEZONE || "Europe/Moscow",
  now = () => new Date(),
}) {
  new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));

  function todayKey() {
    return dateKeyInZone(now(), timeZone);
  }

  function selectedDate(date) {
    return parseDateKey(date || todayKey());
  }

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

  async function findOwnedHabit(userId, habitId) {
    const { data, error } = await supabase
      .from("habits")
      .select("id, title")
      .eq("id", habitId)
      .eq("user_id", userId)
      .maybeSingle();

    throwIfError(error, "habit lookup");
    return data;
  }

  async function findCompletion(userId, habitId, date) {
    const { data, error } = await supabase
      .from("habit_completions")
      .select("id, habit_id, completed_date, created_at")
      .eq("habit_id", habitId)
      .eq("user_id", userId)
      .eq("completed_date", date)
      .maybeSingle();

    throwIfError(error, "habit completion lookup");
    return data;
  }

  async function complete_habit(ctx, { habit_id, date } = {}) {
    validateHabitId(habit_id);
    const completedDate = selectedDate(date);
    const userId = await resolveUserId(ctx);
    const habit = await findOwnedHabit(userId, habit_id);
    if (!habit) {
      const notFound = new Error("Habit not found for this Planner account");
      notFound.code = "HABIT_NOT_FOUND";
      throw notFound;
    }

    const existing = await findCompletion(userId, habit_id, completedDate);
    if (existing) {
      return { completed: true, already_completed: true, habit, completion: existing };
    }

    const { data, error } = await supabase
      .from("habit_completions")
      .insert({ habit_id, user_id: userId, completed_date: completedDate })
      .select("id, habit_id, completed_date, created_at")
      .single();

    if (error) {
      // A concurrent request may have inserted the same unique (habit_id, date) pair.
      const racedCompletion = await findCompletion(userId, habit_id, completedDate);
      if (racedCompletion) {
        return { completed: true, already_completed: true, habit, completion: racedCompletion };
      }
      throwIfError(error, "habit completion insert");
    }

    return { completed: true, already_completed: false, habit, completion: data };
  }

  async function undo_habit_completion(ctx, { habit_id, date } = {}) {
    validateHabitId(habit_id);
    const completedDate = selectedDate(date);
    const userId = await resolveUserId(ctx);
    const habit = await findOwnedHabit(userId, habit_id);
    if (!habit) {
      const notFound = new Error("Habit not found for this Planner account");
      notFound.code = "HABIT_NOT_FOUND";
      throw notFound;
    }

    const completion = await findCompletion(userId, habit_id, completedDate);
    if (!completion) {
      return { completed: false, already_undone: true, habit, date: completedDate };
    }

    const { data, error } = await supabase
      .from("habit_completions")
      .delete()
      .eq("id", completion.id)
      .eq("habit_id", habit_id)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();

    throwIfError(error, "habit completion deletion");
    if (!data) {
      return { completed: false, already_undone: true, habit, date: completedDate };
    }
    return { completed: false, already_undone: false, habit, date: completedDate };
  }

  return { complete_habit, undo_habit_completion };
}

module.exports = { createHabitTools };
