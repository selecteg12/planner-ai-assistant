require("dotenv").config({ path: ".env.local" });

const { createClient } = require("@supabase/supabase-js");
const { Telegram } = require("telegraf");
const { createReadTools } = require("./read-tools");
const { processMorningSummaries } = require("./morning-summary");

const REMINDER_FIELDS = "id, user_id, text, remind_at, status, claimed_at";
const CLAIMED_REMINDER_FIELDS = "id, user_id, text, remind_at, claimed_at";

function throwIfError(error, operation) {
  if (error) {
    const wrapped = new Error(`Planner ${operation} failed`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function safeErrorCode(error) {
  return String(error?.code || error?.name || "UNKNOWN").slice(0, 64);
}

async function processDueReminders({
  supabase,
  telegram,
  now = () => new Date(),
  batchSize = 50,
  logger = console,
}) {
  const currentTime = now().toISOString();
  const { data: dueReminders, error: dueError } = await supabase
    .from("reminders")
    .select(REMINDER_FIELDS)
    .eq("status", "pending")
    .lte("remind_at", currentTime)
    .order("remind_at", { ascending: true })
    .limit(batchSize);

  throwIfError(dueError, "due reminder query");
  const due = dueReminders || [];
  if (!due.length) return { due: 0, claimed: 0, sent: 0, failed: 0, skipped: 0 };

  const userIds = [...new Set(due.map((reminder) => reminder.user_id))];
  const { data: links, error: linksError } = await supabase
    .from("telegram_users")
    .select("supabase_user_id, telegram_id")
    .in("supabase_user_id", userIds);

  throwIfError(linksError, "Telegram link query");
  const linksByUser = new Map();
  for (const link of links || []) {
    if (linksByUser.has(link.supabase_user_id)) {
      linksByUser.set(link.supabase_user_id, null);
    } else {
      linksByUser.set(link.supabase_user_id, link);
    }
  }

  const result = { due: due.length, claimed: 0, sent: 0, failed: 0, skipped: 0 };
  for (const reminder of due) {
    const link = linksByUser.get(reminder.user_id);
    if (!link) {
      // Leave it pending so a repaired Telegram binding can still receive it.
      result.skipped += 1;
      logger.warn("Reminder skipped: no unique Telegram link.");
      continue;
    }

    const claimedAt = now().toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from("reminders")
      .update({ status: "processing", claimed_at: claimedAt })
      .eq("id", reminder.id)
      .eq("user_id", reminder.user_id)
      .eq("status", "pending")
      .lte("remind_at", claimedAt)
      .select(CLAIMED_REMINDER_FIELDS)
      .maybeSingle();

    throwIfError(claimError, "reminder claim");
    if (!claimed) {
      // Another scheduler instance already claimed or cancelled this reminder.
      result.skipped += 1;
      continue;
    }
    result.claimed += 1;

    try {
      await telegram.sendMessage(link.telegram_id, claimed.text);
    } catch (error) {
      // Keep the claim to avoid duplicate delivery if Telegram accepted the
      // request but the response was lost. Manual recovery may be needed.
      result.failed += 1;
      logger.error(`Reminder delivery failed (${safeErrorCode(error)}); claim retained.`);
      continue;
    }

    const sentAt = now().toISOString();
    const { data: sent, error: sentError } = await supabase
      .from("reminders")
      .update({ status: "sent", sent_at: sentAt, claimed_at: null })
      .eq("id", claimed.id)
      .eq("user_id", claimed.user_id)
      .eq("status", "processing")
      .select("id")
      .maybeSingle();

    if (sentError || !sent) {
      // Delivery already happened. Do not resend if acknowledging it failed.
      result.failed += 1;
      logger.error(`Reminder acknowledgement failed (${safeErrorCode(sentError)}); claim retained.`);
      continue;
    }
    result.sent += 1;
  }

  return result;
}

function startScheduler({ runOnce, intervalMs = 15_000, logger = console }) {
  let stopped = false;
  let timer = null;
  let wakeTimer = null;
  const finished = (async () => {
    while (!stopped) {
      try {
        await runOnce();
      } catch (error) {
        logger.error(`Reminder scheduler cycle failed (${safeErrorCode(error)}).`);
      }
      if (stopped) break;
      await new Promise((resolve) => {
        wakeTimer = resolve;
        timer = setTimeout(resolve, intervalMs);
      });
      timer = null;
      wakeTimer = null;
    }
  })();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (wakeTimer) wakeTimer();
      await finished;
    },
    finished,
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveIntegerEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function boundedIntegerEnv(name, fallback, min, max) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

if (require.main === module) {
  const supabase = createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_SECRET_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
  );
  const telegram = new Telegram(requiredEnv("TELEGRAM_BOT_TOKEN"));
  const intervalMs = positiveIntegerEnv("REMINDER_POLL_INTERVAL_MS", 15_000);
  const batchSize = positiveIntegerEnv("REMINDER_BATCH_SIZE", 50);
  const morningSummariesEnabled = process.env.MORNING_SUMMARY_ENABLED === "true";
  const morningSummaryHour = boundedIntegerEnv("MORNING_SUMMARY_HOUR", 8, 0, 23);
  const morningSummaryMinute = boundedIntegerEnv("MORNING_SUMMARY_MINUTE", 0, 0, 59);
  const morningSummaryWindowMinutes = boundedIntegerEnv("MORNING_SUMMARY_WINDOW_MINUTES", 60, 1, 180);
  const readTools = morningSummariesEnabled ? createReadTools({ supabase }) : null;
  const scheduler = startScheduler({
    runOnce: async () => {
      await processDueReminders({ supabase, telegram, batchSize });
      if (morningSummariesEnabled) {
        await processMorningSummaries({
          supabase,
          telegram,
          readTools,
          hour: morningSummaryHour,
          minute: morningSummaryMinute,
          windowMinutes: morningSummaryWindowMinutes,
        });
      }
    },
    intervalMs,
  });

  console.log(`Reminder scheduler started. Morning summaries: ${morningSummariesEnabled ? "enabled" : "disabled"}.`);
  const shutdown = async () => {
    await scheduler.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = { processDueReminders, startScheduler, boundedIntegerEnv };
