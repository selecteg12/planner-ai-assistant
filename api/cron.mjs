import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("dotenv").config({ path: ".env.local", quiet: true });

const { createClient } = require("@supabase/supabase-js");
const { Telegram } = require("telegraf");
const { processDueReminders } = require("../scheduler.js");
const { processMorningSummaries } = require("../morning-summary.js");
const { createReadTools } = require("../read-tools.js");
const { validBearer } = require("../endpoint-auth.js");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function plannerCron(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !validBearer(req, cronSecret)) {
    return json(res, 401, { error: "unauthorized" });
  }

  try {
    const supabase = createClient(
      requiredEnv("SUPABASE_URL"),
      requiredEnv("SUPABASE_SECRET_KEY"),
      { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
    );
    const telegram = new Telegram(requiredEnv("TELEGRAM_BOT_TOKEN"));
    const currentTime = new Date();
    if (currentTime.getUTCHours() === 3 && currentTime.getUTCMinutes() === 0) {
      const expiredBefore = new Date(currentTime.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { error: cleanupError } = await supabase
        .from("telegram_webhook_updates")
        .delete()
        .lt("received_at", expiredBefore);
      if (cleanupError) throw new Error("Telegram update receipt cleanup failed");
    }

    const parsedBatchSize = Number(process.env.REMINDER_BATCH_SIZE || 50);
    if (!Number.isSafeInteger(parsedBatchSize) || parsedBatchSize <= 0) {
      return json(res, 500, { error: "invalid_scheduler_configuration" });
    }

    const reminders = await processDueReminders({ supabase, telegram, batchSize: parsedBatchSize });
    let morningSummaries = null;
    if (process.env.MORNING_SUMMARY_ENABLED === "true") {
      morningSummaries = await processMorningSummaries({
        supabase,
        telegram,
        readTools: createReadTools({ supabase }),
        hour: Number(process.env.MORNING_SUMMARY_HOUR || 8),
        minute: Number(process.env.MORNING_SUMMARY_MINUTE || 0),
        windowMinutes: Number(process.env.MORNING_SUMMARY_WINDOW_MINUTES || 60),
      });
    }

    return json(res, 200, { ok: true, reminders, morningSummaries });
  } catch (error) {
    console.error(`Planner cron failed (${String(error?.name || "UNKNOWN").slice(0, 64)}).`);
    return json(res, 500, { error: "scheduled_job_failed" });
  }
}
