const DAY_MS = 24 * 60 * 60 * 1000;

function dateKeyInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseDateKey(value, name = "date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${name} must be an ISO date (YYYY-MM-DD)`);
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new TypeError(`${name} is not a valid calendar date`);
  }

  return value;
}

function addDays(dateKey, amount) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.toISOString().slice(0, 10);
}

function zonedMidnight(dateKey, timeZone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;

  // Resolve local midnight to UTC without relying on the server's local timezone.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second)
    );
    guess += target - represented;
  }

  return new Date(guess).toISOString();
}

function localDateTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: date.getUTCMilliseconds(),
  };
}

function zonedDateTime(dateKey, parts, timeZone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, parts.hour, parts.minute, parts.second, parts.millisecond);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = localDateTimeParts(new Date(guess), timeZone);
    const [localYear, localMonth, localDay] = local.date.split("-").map(Number);
    const represented = Date.UTC(
      localYear, localMonth - 1, localDay,
      local.hour, local.minute, local.second, parts.millisecond
    );
    guess += target - represented;
  }
  return new Date(guess);
}

function nextRecurrenceDate(dateKey, recurrence) {
  if (recurrence === "daily") return addDays(dateKey, 1);
  if (recurrence === "weekly") return addDays(dateKey, 7);

  const [year, month, day] = dateKey.split("-").map(Number);
  if (recurrence === "monthly") {
    const target = new Date(Date.UTC(year, month, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
  }
  if (recurrence === "yearly") {
    const targetYear = year + 1;
    const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
    return `${targetYear}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
  }
  return null;
}

function expandEvents(events, startDate, endDate, timeZone) {
  const expanded = [];
  for (const event of events) {
    const recurrence = event.recurrence || "none";
    const originalStart = new Date(event.start_at);
    const originalEnd = new Date(event.end_at);
    const duration = originalEnd.getTime() - originalStart.getTime();
    if (recurrence === "none" || !event.recurrence_end_date) {
      expanded.push(event);
      continue;
    }

    const originalDate = dateKeyInZone(originalStart, timeZone);
    if (event.recurrence_end_date < originalDate) {
      expanded.push(event);
      continue;
    }

    const localTime = localDateTimeParts(originalStart, timeZone);
    let occurrenceDate = originalDate;
    let safety = 0;
    while (occurrenceDate <= event.recurrence_end_date && safety < 1000) {
      if (occurrenceDate >= startDate && occurrenceDate <= endDate) {
        const occurrenceStart = zonedDateTime(occurrenceDate, localTime, timeZone);
        expanded.push({
          ...event,
          start_at: occurrenceStart.toISOString(),
          end_at: new Date(occurrenceStart.getTime() + duration).toISOString(),
          occurrence_id: `${event.id}-${occurrenceDate}`,
          is_recurring_occurrence: true,
        });
      }
      occurrenceDate = nextRecurrenceDate(occurrenceDate, recurrence);
      if (!occurrenceDate) break;
      safety += 1;
    }
  }

  return expanded.sort((left, right) => Date.parse(left.start_at) - Date.parse(right.start_at));
}

function weekStartFor(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return addDays(dateKey, -daysSinceMonday);
}

function throwIfError(error, operation) {
  if (error) {
    const wrapped = new Error(`Planner ${operation} failed`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function createReadTools({
  supabase,
  timeZone = process.env.PLANNER_TIMEZONE || "Europe/Moscow",
  now = () => new Date(),
}) {
  // Validate timezone eagerly so date filtering cannot silently use server-local time.
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

  function todayKey() {
    return dateKeyInZone(now(), timeZone);
  }

  async function queryEvents(userId, startDate, endDate) {
    const start = zonedMidnight(startDate, timeZone);
    const endExclusive = zonedMidnight(addDays(endDate, 1), timeZone);
    const baseQuery = () => supabase
      .from("events")
      .select("id, title, start_at, end_at, color, created_at, recurrence, recurrence_end_date")
      .eq("user_id", userId);
    const [directResult, recurringResult] = await Promise.all([
      baseQuery().lt("start_at", endExclusive).gt("end_at", start),
      baseQuery().lt("start_at", endExclusive).gte("recurrence_end_date", startDate),
    ]);

    throwIfError(directResult.error, "events query");
    throwIfError(recurringResult.error, "recurring events query");
    const uniqueEvents = new Map();
    for (const event of [...(directResult.data || []), ...(recurringResult.data || [])]) {
      uniqueEvents.set(event.id, event);
    }
    return expandEvents([...uniqueEvents.values()], startDate, endDate, timeZone);
  }

  async function queryTasks(userId, filter, date) {
    let query = supabase
      .from("tasks")
      .select("id, title, note, deadline, priority, done, created_at, completed_at")
      .eq("user_id", userId);

    if (filter === "open" || filter === "today" || filter === "future" || filter === "overdue") {
      query = query.eq("done", false);
    }

    if (filter === "today") query = query.eq("deadline", date);
    if (filter === "future") query = query.gt("deadline", date);
    if (filter === "overdue") query = query.lt("deadline", date);

    const { data, error } = await query
      .order("deadline", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });

    throwIfError(error, "tasks query");
    return data || [];
  }

  async function queryTasksBetween(userId, startDate, endDate) {
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, note, deadline, priority, done, created_at, completed_at")
      .eq("user_id", userId)
      .gte("deadline", startDate)
      .lte("deadline", endDate)
      .order("deadline", { ascending: true })
      .order("created_at", { ascending: false });

    throwIfError(error, "weekly tasks query");
    return data || [];
  }

  async function queryHabits(userId, startDate, endDate, currentDate) {
    const [habitsResult, completionsResult] = await Promise.all([
      supabase
        .from("habits")
        .select("id, title, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: true }),
      supabase
        .from("habit_completions")
        .select("id, habit_id, completed_date, created_at")
        .eq("user_id", userId)
        .gte("completed_date", startDate)
        .lte("completed_date", endDate)
        .order("completed_date", { ascending: true }),
    ]);

    throwIfError(habitsResult.error, "habits query");
    throwIfError(completionsResult.error, "habit completions query");

    const completions = completionsResult.data || [];
    return (habitsResult.data || []).map((habit) => {
      const habitCompletions = completions.filter(
        (completion) => completion.habit_id === habit.id
      );
      return {
        ...habit,
        completed: habitCompletions.some(
          (completion) => completion.completed_date === currentDate
        ),
        completions: habitCompletions,
      };
    });
  }

  async function get_today(ctx, { date } = {}) {
    const userId = await resolveUserId(ctx);
    const currentDate = parseDateKey(date || todayKey());
    const [events, tasks, overdueTasks, habits] = await Promise.all([
      queryEvents(userId, currentDate, currentDate),
      queryTasks(userId, "today", currentDate),
      queryTasks(userId, "overdue", currentDate),
      queryHabits(userId, currentDate, currentDate, currentDate),
    ]);

    return { date: currentDate, events, tasks, overdue_tasks: overdueTasks, habits };
  }

  async function get_events(ctx, { start_date, end_date } = {}) {
    const startDate = parseDateKey(start_date, "start_date");
    const endDate = parseDateKey(end_date, "end_date");
    if (startDate > endDate) throw new TypeError("start_date must be on or before end_date");
    const userId = await resolveUserId(ctx);
    return { start_date: startDate, end_date: endDate, events: await queryEvents(userId, startDate, endDate) };
  }

  async function get_tasks(ctx, { filter = "open", date } = {}) {
    const supportedFilters = new Set(["today", "future", "overdue", "open", "all"]);
    if (!supportedFilters.has(filter)) {
      throw new TypeError(`Unsupported task filter: ${filter}`);
    }
    const currentDate = parseDateKey(date || todayKey());
    const userId = await resolveUserId(ctx);
    return { filter, date: currentDate, tasks: await queryTasks(userId, filter, currentDate) };
  }

  async function get_habits(ctx, { date } = {}) {
    const selectedDate = parseDateKey(date || todayKey());
    const userId = await resolveUserId(ctx);
    const habits = await queryHabits(userId, selectedDate, selectedDate, selectedDate);
    return { date: selectedDate, habits };
  }

  async function get_week(ctx, { date } = {}) {
    const selectedDate = parseDateKey(date || todayKey());
    const startDate = weekStartFor(selectedDate);
    const endDate = addDays(startDate, 6);
    const userId = await resolveUserId(ctx);
    const [events, tasks, overdueTasks, habits] = await Promise.all([
      queryEvents(userId, startDate, endDate),
      queryTasksBetween(userId, startDate, endDate),
      queryTasks(userId, "overdue", startDate),
      queryHabits(userId, startDate, endDate, selectedDate),
    ]);

    return {
      start_date: startDate,
      end_date: endDate,
      events,
      tasks,
      overdue_tasks: overdueTasks,
      habits,
    };
  }

  return { get_today, get_tasks, get_events, get_habits, get_week };
}

module.exports = {
  createReadTools,
  addDays,
  dateKeyInZone,
  parseDateKey,
  weekStartFor,
  expandEvents,
};
