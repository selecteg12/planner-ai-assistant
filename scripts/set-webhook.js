require("dotenv").config({ path: ".env.local", quiet: true });

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const token = requiredEnv("TELEGRAM_BOT_TOKEN");
  const url = new URL(requiredEnv("TELEGRAM_WEBHOOK_URL"));
  const secret = requiredEnv("TELEGRAM_WEBHOOK_SECRET");
  if (url.protocol !== "https:") throw new Error("TELEGRAM_WEBHOOK_URL must use HTTPS");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must use 1–256 characters: A–Z, a–z, 0–9, _ or -.");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: url.toString(),
      secret_token: secret,
      max_connections: 1,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram rejected the webhook configuration (${response.status}).`);
  }
  console.log("Telegram webhook configured.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
