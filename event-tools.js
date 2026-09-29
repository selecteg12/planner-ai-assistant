const { dateKeyInZone, parseDateKey } = require("./read-tools");

const EVENT_FIELDS = "id, title, start_at, end_at, color, created_at, recurrence, recurrence_end_date";
const EVENT_COLORS = new Set(["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"]);
const RECURRENCES = new Set(["none", "daily", "weekly", "monthly", "yearly"]);
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function throwIfError(error, operation) {
  if (error) {
    const wrapped = new Error(`Planner ${operation} failed`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function validateEventId(eventId) {
  if (typeof eventId !== "string" || !EVENT_ID_PATTERN.test(eventId)) {
    throw new TypeError("event_id must be a valid UUID");
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

function validateTimestamp(value, name) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp with an explicit timezone`);
  }
  parseDateKey(value.slice(0, 10), `${name} date`);
  return new Date(value).toISOString();
}

function validateColor(color) {
  if (!EVENT_COLORS.has(color)) {
    throw new TypeError("color must be one of the Planner calendar colors");
  }
  return color;
}

function validateRecurrence(recurrence) {
  if (!RECURRENCES.has(recurrence)) {
    throw new TypeError("recurrence must be none, daily, weekly, monthly, or yearly");
  }
  return recurrence;
}

function validateInterval(startAt, endAt, timeZone) {
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    throw new TypeError("end_at must be later than start_at");
  }
  const startDay = dateKeyInZone(new Date(startAt), timeZone);
  const endDay = dateKeyInZone(new Date(endAt), timeZone);
  if (startDay !== endDay) {
    throw new TypeError("Planner events must start and end on the same local date");
  }
  return startDay;
}

function validateRecurrenceEnd(recurrence, recurrenceEndDate, startDate) {
  if (recurrence === "none") return null;
  const endDate = parseDateKey(recurrenceEndDate, "recurrence_end_date");
  if (endDate < startDate) {
    throw new TypeError("recurrence_end_date cannot be before the event date");
  }
  return endDate;
}

function createEventTools({
  supabase,
  timeZone = process.env.PLANNER_TIMEZONE || "Europe/Moscow",
}) {
  new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));

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

  async function findEvent(userId, eventId) {
    const { data, error } = await supabase
      .from("events")
      .select(EVENT_FIELDS)
      .eq("id", eventId)
      .eq("user_id", userId)
      .maybeSingle();
    throwIfError(error, "event lookup");
    return data;
  }

  async function create_event(ctx, args = {}) {
    const allowed = new Set(["title", "start_at", "end_at", "color", "recurrence", "recurrence_end_date"]);
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) throw new TypeError(`Unsupported event field: ${key}`);
    }

    const title = validateTitle(args.title);
    const startAt = validateTimestamp(args.start_at, "start_at");
    const endAt = validateTimestamp(args.end_at, "end_at");
    const startDate = validateInterval(startAt, endAt, timeZone);
    const recurrence = validateRecurrence(args.recurrence === undefined ? "none" : args.recurrence);
    const recurrenceEndDate = recurrence === "none"
      ? null
      : validateRecurrenceEnd(recurrence, args.recurrence_end_date, startDate);
    const color = args.color === undefined ? "#3b82f6" : validateColor(args.color);
    const userId = await resolveUserId(ctx);

    const { data, error } = await supabase
      .from("events")
      .insert({
        title,
        start_at: startAt,
        end_at: endAt,
        color,
        recurrence,
        recurrence_end_date: recurrenceEndDate,
        user_id: userId,
      })
      .select(EVENT_FIELDS)
      .single();

    throwIfError(error, "event creation");
    return { created: true, event: data };
  }

  async function update_event(ctx, args = {}) {
    const allowed = new Set(["event_id", "title", "start_at", "end_at", "color", "recurrence", "recurrence_end_date"]);
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) throw new TypeError(`Unsupported event field: ${key}`);
    }
    validateEventId(args.event_id);

    const userId = await resolveUserId(ctx);
    const existing = await findEvent(userId, args.event_id);
    if (!existing) {
      const notFound = new Error("Event not found for this Planner account");
      notFound.code = "EVENT_NOT_FOUND";
      throw notFound;
    }

    const patch = {};
    if (Object.hasOwn(args, "title")) patch.title = validateTitle(args.title);
    if (Object.hasOwn(args, "color")) patch.color = validateColor(args.color);

    const startAt = Object.hasOwn(args, "start_at")
      ? validateTimestamp(args.start_at, "start_at")
      : existing.start_at;
    const endAt = Object.hasOwn(args, "end_at")
      ? validateTimestamp(args.end_at, "end_at")
      : existing.end_at;
    const startDate = validateInterval(startAt, endAt, timeZone);
    if (Object.hasOwn(args, "start_at")) patch.start_at = startAt;
    if (Object.hasOwn(args, "end_at")) patch.end_at = endAt;

    const recurrence = Object.hasOwn(args, "recurrence")
      ? validateRecurrence(args.recurrence)
      : existing.recurrence || "none";
    if (Object.hasOwn(args, "recurrence")) patch.recurrence = recurrence;

    if (recurrence === "none") {
      if (Object.hasOwn(args, "recurrence") || Object.hasOwn(args, "recurrence_end_date")) {
        patch.recurrence_end_date = null;
      }
    } else if (
      Object.hasOwn(args, "recurrence") ||
      Object.hasOwn(args, "recurrence_end_date") ||
      Object.hasOwn(args, "start_at")
    ) {
      const requestedEndDate = Object.hasOwn(args, "recurrence_end_date")
        ? args.recurrence_end_date
        : existing.recurrence_end_date;
      patch.recurrence_end_date = validateRecurrenceEnd(recurrence, requestedEndDate, startDate);
    }

    if (Object.keys(patch).length === 0) {
      throw new TypeError("At least one event field must be provided");
    }

    const { data, error } = await supabase
      .from("events")
      .update(patch)
      .eq("id", args.event_id)
      .eq("user_id", userId)
      .select(EVENT_FIELDS)
      .maybeSingle();

    throwIfError(error, "event update");
    if (!data) {
      const notFound = new Error("Event not found for this Planner account");
      notFound.code = "EVENT_NOT_FOUND";
      throw notFound;
    }
    return { updated: true, event: data };
  }

  async function delete_event(ctx, { event_id } = {}) {
    validateEventId(event_id);
    const userId = await resolveUserId(ctx);
    const { data, error } = await supabase
      .from("events")
      .delete()
      .eq("id", event_id)
      .eq("user_id", userId)
      .select("id, title")
      .maybeSingle();

    throwIfError(error, "event deletion");
    if (!data) {
      const notFound = new Error("Event not found for this Planner account");
      notFound.code = "EVENT_NOT_FOUND";
      throw notFound;
    }
    return { deleted: true, event: data };
  }

  return { create_event, update_event, delete_event };
}

module.exports = { createEventTools };
