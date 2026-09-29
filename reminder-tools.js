const { parseDateKey } = require("./read-tools");

const REMINDER_FIELDS = "id, text, remind_at, sent_at, status, claimed_at, created_at";
const REMINDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function throwIfError(error, operation) {
  if (error) {
    const wrapped = new Error(`Planner ${operation} failed`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function validateReminderId(reminderId) {
  if (typeof reminderId !== "string" || !REMINDER_ID_PATTERN.test(reminderId)) {
    throw new TypeError("reminder_id must be a valid UUID");
  }
}

function validateReminderText(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new TypeError("text must be a non-empty string");
  }
  return text.trim();
}

function validateRemindAt(value, now) {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError("remind_at must be an ISO timestamp with an explicit timezone");
  }
  parseDateKey(value.slice(0, 10), "remind_at date");
  const instant = new Date(value);
  if (instant.getTime() <= now.getTime()) {
    throw new TypeError("remind_at must be in the future");
  }
  return instant.toISOString();
}

function createReminderTools({ supabase, now = () => new Date() }) {
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

  async function findOwnedReminder(userId, reminderId) {
    const { data, error } = await supabase
      .from("reminders")
      .select(REMINDER_FIELDS)
      .eq("id", reminderId)
      .eq("user_id", userId)
      .maybeSingle();
    throwIfError(error, "reminder lookup");
    return data;
  }

  async function create_reminder(ctx, args = {}) {
    for (const key of Object.keys(args)) {
      if (!["text", "remind_at"].includes(key)) {
        throw new TypeError(`Unsupported reminder field: ${key}`);
      }
    }
    const text = validateReminderText(args.text);
    const remindAt = validateRemindAt(args.remind_at, now());
    const userId = await resolveUserId(ctx);

    const { data, error } = await supabase
      .from("reminders")
      .insert({ text, remind_at: remindAt, user_id: userId })
      .select(REMINDER_FIELDS)
      .single();

    throwIfError(error, "reminder creation");
    return { created: true, reminder: data };
  }

  async function cancel_reminder(ctx, { reminder_id } = {}) {
    validateReminderId(reminder_id);
    const userId = await resolveUserId(ctx);
    const existing = await findOwnedReminder(userId, reminder_id);
    if (!existing) {
      const notFound = new Error("Reminder not found for this Planner account");
      notFound.code = "REMINDER_NOT_FOUND";
      throw notFound;
    }
    if (existing.status === "cancelled") {
      return { cancelled: true, already_cancelled: true, reminder: existing };
    }
    if (existing.status === "sent") {
      return { cancelled: false, already_sent: true, reminder: existing };
    }
    if (existing.status !== "pending" && existing.status !== "processing") {
      throw new Error("Reminder has an unsupported state");
    }

    const { data, error } = await supabase
      .from("reminders")
      .update({ status: "cancelled", claimed_at: null })
      .eq("id", reminder_id)
      .eq("user_id", userId)
      .eq("status", existing.status)
      .select(REMINDER_FIELDS)
      .maybeSingle();

    throwIfError(error, "reminder cancellation");
    if (data) return { cancelled: true, already_cancelled: false, reminder: data };

    // Resolve a concurrent cancellation or send without changing a terminal state.
    const current = await findOwnedReminder(userId, reminder_id);
    if (current?.status === "cancelled") {
      return { cancelled: true, already_cancelled: true, reminder: current };
    }
    if (current?.status === "sent") {
      return { cancelled: false, already_sent: true, reminder: current };
    }
    const notFound = new Error("Reminder could not be cancelled in its current state");
    notFound.code = "REMINDER_STATE_CHANGED";
    throw notFound;
  }

  return { create_reminder, cancel_reminder };
}

module.exports = { createReminderTools };
