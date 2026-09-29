import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { bot, supabase } = require("../bot.js");
const { safeEqual } = require("../endpoint-auth.js");

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function parseUpdate(body) {
  if (typeof body === "string") return JSON.parse(body);
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString("utf8"));
  return body;
}

export default async function telegramWebhook(req, res) {
  if (req.method !== "POST") return reply(res, 405, "Method not allowed");
  if (process.env.TELEGRAM_SESSION_STORE !== "supabase") {
    return reply(res, 503, "Webhook sessions are not configured");
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !safeEqual(req.headers?.["x-telegram-bot-api-secret-token"], secret)) {
    return reply(res, 401, "Unauthorized");
  }

  let update;
  try {
    update = parseUpdate(req.body);
  } catch {
    return reply(res, 400, "Invalid update");
  }
  if (!update || !Number.isSafeInteger(update.update_id)) {
    return reply(res, 400, "Invalid update");
  }

  try {
    const { data: claim, error: claimError } = await supabase
      .from("telegram_webhook_updates")
      .insert({ update_id: update.update_id, status: "processing" })
      .select("update_id")
      .maybeSingle();

    if (claimError?.code === "23505") return reply(res, 200, "ok");
    if (claimError || !claim) throw new Error("Unable to claim Telegram update");

    await bot.handleUpdate(update);
    const { error: completeError } = await supabase
      .from("telegram_webhook_updates")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("update_id", update.update_id)
      .eq("status", "processing");
    if (completeError) {
      // The update has already been handled. Do not invite Telegram to redeliver it.
      console.error("Telegram webhook completion could not be recorded.");
    }
    return reply(res, 200, "ok");
  } catch (error) {
    await supabase
      .from("telegram_webhook_updates")
      .update({ status: "failed" })
      .eq("update_id", update.update_id)
      .eq("status", "processing");
    console.error(`Telegram webhook failed (${String(error?.name || "UNKNOWN").slice(0, 64)}).`);
    return reply(res, 500, "Webhook processing failed");
  }
}
