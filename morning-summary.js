const { dateKeyInZone, addDays } = require("./read-tools");

const DELIVERY_FIELDS = "user_id, summary_date, status, claimed_at";

function throwIfError(error, operation) {
  if (!error) return;
  const wrapped = new Error(`Planner ${operation} failed`);
  wrapped.cause = error;
  throw wrapped;
}

function formatTime(value, timeZone) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMorningSummary({ today, openTasks = [], timeZone = "Europe/Moscow" }) {
  const date = new Date(`${today.date}T12:00:00Z`);
  const dateLabel = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
  const sections = [`☀️ План на ${dateLabel}`];
  const append = (title, lines) => {
    if (lines.length) sections.push(`\n${title}\n${lines.join("\n")}`);
  };

  append("События", (today.events || []).map((event) =>
    `• ${formatTime(event.start_at, timeZone)}–${formatTime(event.end_at, timeZone)} — ${event.title}`
  ));

  append("Просроченные задачи", (today.overdue_tasks || []).slice(0, 5).map((task) =>
    `• ${task.title}${task.deadline ? ` (срок ${task.deadline})` : ""}`
  ));

  const todayTasks = today.tasks || [];
  const important = openTasks.filter((task) => task.priority === "high").slice(0, 5);
  append("Важные задачи", important.map((task) =>
    `• ${task.title}${task.deadline ? ` (до ${task.deadline})` : ""}`
  ));

  const nextWeekDeadlines = openTasks.filter((task) =>
    task.deadline && task.deadline > today.date && task.deadline <= addDays(today.date, 7)
  ).slice(0, 5);
  append("Ближайшие сроки", nextWeekDeadlines.map((task) =>
    `• ${task.deadline} — ${task.title}`
  ));

  append("Задачи на сегодня", todayTasks.slice(0, 7).map((task) => `• ${task.title}`));
  append("Привычки", (today.habits || []).map((habit) =>
    `• ${habit.title} — ${habit.completed ? "выполнена" : "ещё не отмечена"}`
  ));

  if (sections.length === 1) sections.push("\nНа сегодня в Planner пока нет запланированных дел.");
  return sections.join("\n").slice(0, 3900);
}

function localClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function isInDeliveryWindow(date, { timeZone, hour, minute, windowMinutes }) {
  const current = localClock(date, timeZone);
  const target = hour * 60 + minute;
  return current >= target && current < target + windowMinutes;
}

async function processMorningSummaries({
  supabase,
  telegram,
  readTools,
  now = () => new Date(),
  timeZone = process.env.PLANNER_TIMEZONE || "Europe/Moscow",
  hour = 8,
  minute = 0,
  windowMinutes = 60,
  logger = console,
}) {
  const current = now();
  if (!isInDeliveryWindow(current, { timeZone, hour, minute, windowMinutes })) {
    return { users: 0, claimed: 0, sent: 0, skipped: 0, failed: 0 };
  }

  const summaryDate = dateKeyInZone(current, timeZone);
  const { data: links, error: linksError } = await supabase
    .from("telegram_users")
    .select("telegram_id, supabase_user_id");
  throwIfError(linksError, "morning summary Telegram link query");

  const result = { users: (links || []).length, claimed: 0, sent: 0, skipped: 0, failed: 0 };
  const seenUsers = new Set();
  for (const link of links || []) {
    if (seenUsers.has(link.supabase_user_id)) {
      result.skipped += 1;
      logger.warn("Morning summary skipped: duplicate Planner link.");
      continue;
    }
    seenUsers.add(link.supabase_user_id);

    let summary;
    try {
      const ctx = { from: { id: link.telegram_id } };
      const [today, tasksResult] = await Promise.all([
        readTools.get_today(ctx),
        readTools.get_tasks(ctx, { filter: "open" }),
      ]);
      summary = formatMorningSummary({ today, openTasks: tasksResult.tasks, timeZone });
    } catch (error) {
      result.failed += 1;
      logger.error(`Morning summary data query failed (${String(error?.code || error?.name || "UNKNOWN").slice(0, 64)}).`);
      continue;
    }

    const claimedAt = now().toISOString();
    const { data: claim, error: claimError } = await supabase
      .from("morning_summary_deliveries")
      .insert({
        user_id: link.supabase_user_id,
        summary_date: summaryDate,
        status: "processing",
        claimed_at: claimedAt,
      })
      .select(DELIVERY_FIELDS)
      .maybeSingle();

    if (claimError?.code === "23505") {
      result.skipped += 1;
      continue;
    }
    throwIfError(claimError, "morning summary claim");
    if (!claim) {
      result.skipped += 1;
      continue;
    }
    result.claimed += 1;

    try {
      await telegram.sendMessage(link.telegram_id, summary);
    } catch (error) {
      // A lost Telegram response is ambiguous. Keep the claim to prevent duplicates.
      result.failed += 1;
      logger.error(`Morning summary delivery failed (${String(error?.code || error?.name || "UNKNOWN").slice(0, 64)}); claim retained.`);
      continue;
    }

    const { data: sent, error: sentError } = await supabase
      .from("morning_summary_deliveries")
      .update({ status: "sent", sent_at: now().toISOString(), claimed_at: null })
      .eq("user_id", claim.user_id)
      .eq("summary_date", claim.summary_date)
      .eq("status", "processing")
      .select("user_id")
      .maybeSingle();

    if (sentError || !sent) {
      result.failed += 1;
      logger.error("Morning summary acknowledgement failed; claim retained.");
      continue;
    }
    result.sent += 1;
  }

  return result;
}

module.exports = { formatMorningSummary, isInDeliveryWindow, processMorningSummaries };
