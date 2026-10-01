require("dotenv").config({ path: ".env.local" });

const { createHash } = require("node:crypto");
const { Telegraf, session } = require("telegraf");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");
const { createReadTools } = require("./read-tools");
const { createTaskTools } = require("./task-tools");
const { createEventTools } = require("./event-tools");
const { createHabitTools } = require("./habit-tools");
const { createIdeaTools } = require("./idea-tools");
const { createReminderTools } = require("./reminder-tools");
const { runPlannerAssistant, confirmPlannerDeletion } = require("./ai-assistant");
const { createSupabaseSessionStore } = require("./supabase-session-store");

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

// Серверный Supabase-клиент.
// ВАЖНО: SUPABASE_SECRET_KEY хранится только в .env.local.
const supabaseUrl = requireEnv("SUPABASE_URL");

// Privileged operations use the server-only secret key.
const supabase = createClient(
  supabaseUrl,
  requireEnv("SUPABASE_SECRET_KEY"),
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }
);

// Persistent sessions are enabled for webhook deployments; local polling keeps
// the existing in-memory behavior unless TELEGRAM_SESSION_STORE=supabase.
const sessionStore = process.env.TELEGRAM_SESSION_STORE === "supabase"
  ? createSupabaseSessionStore({ supabase })
  : undefined;
bot.use(session(sessionStore ? { store: sessionStore } : undefined));
bot.context.plannerReadTools = createReadTools({ supabase });
bot.context.plannerTaskTools = createTaskTools({ supabase });
bot.context.plannerEventTools = createEventTools({ supabase });
bot.context.plannerHabitTools = createHabitTools({ supabase });
bot.context.plannerIdeaTools = createIdeaTools({ supabase });
bot.context.plannerReminderTools = createReminderTools({ supabase });

function getSession(ctx) {
  if (!ctx.session) {
    ctx.session = {};
  }

  return ctx.session;
}

function hashPairingCode(code) {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

// ─────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────

bot.start(async (ctx) => {
  const session = getSession(ctx);

  // Если Telegram уже привязан — сразу приветствуем.
  const { data: existingUser, error } = await supabase
    .from("telegram_users")
    .select("supabase_user_id, telegram_first_name")
    .eq("telegram_id", ctx.from.id)
    .maybeSingle();

  if (error) {
    console.error("Ошибка проверки Telegram:", error);
    return ctx.reply("Не удалось проверить подключение к Planner.");
  }

  if (existingUser) {
    session.step = "connected";
    delete session.email;
    delete session.supabaseUserId;

    return ctx.reply(
      `С возвращением, ${ctx.from.first_name || "Егор"}! 👋\n\n` +
      `Planner уже подключён к этому Telegram-аккаунту.\n\n` +
      `Можешь писать мне обычными сообщениями.`
    );
  }

  session.step = "waiting_pairing_code";

  await ctx.reply(
    `Привет, ${ctx.from.first_name || "человек"} 👋\n\n` +
    `Я — твой личный помощник Planner.\n\n` +
    `Чтобы безопасно подключить аккаунт, открой Planner → Профиль → ` +
    `«Создать код подключения». Затем отправь полученный код сюда.\n\n` +
    `Если Planner ещё не открыт, сначала войди в него в браузере.`
  );
});

// ─────────────────────────────────────────────
// Текстовые сообщения
// ─────────────────────────────────────────────

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const session = getSession(ctx);

  if (text === "/cancel" && session.pendingPlannerDeletion) {
    delete session.pendingPlannerDeletion;
    return ctx.reply("Подтверждение удаления отменено. Запись осталась в Planner.");
  }

  if (text === "/cancel" && session.step === "waiting_pairing_code") {
    delete session.step;
    return ctx.reply("Подключение отменено. Когда будешь готов, отправь /start.");
  }

  // Команды отдельно обрабатываются Telegram.
  if (text.startsWith("/")) return;

  const pendingDeletion = await confirmPlannerDeletion({ ctx, session, text });
  if (pendingDeletion?.handled) return ctx.reply(pendingDeletion.answer);

  if (session.step === "waiting_email" || session.step === "waiting_code") {
    delete session.email;
    delete session.supabaseUserId;
    session.step = "waiting_pairing_code";
    return ctx.reply(
      "Способ подключения обновился. Открой Planner → Профиль → " +
      "«Создать код подключения» и отправь код сюда."
    );
  }

  if (session.step === "waiting_pairing_code") {
    const code = text.replace(/[\s-]/g, "").toUpperCase();

    if (!/^[A-HJ-NP-Z2-9]{16}$/.test(code)) {
      return ctx.reply(
        "Это не похоже на код подключения Planner.\n\n" +
        "Создай новый код в Planner → Профиль и отправь его сюда."
      );
    }

    try {
      await ctx.sendChatAction("typing");
      const { data, error } = await supabase.rpc("consume_telegram_pairing_code", {
        p_code_hash: hashPairingCode(code),
        p_telegram_id: ctx.from.id,
        p_telegram_username: ctx.from.username || null,
        p_telegram_first_name: ctx.from.first_name || null,
      });

      if (error) {
        console.error(`Telegram pairing failed (${String(error.code || error.name || "UNKNOWN").slice(0, 64)}).`);
        return ctx.reply("Не удалось проверить код. Убедись, что в Planner уже создался код, и попробуй ещё раз.");
      }

      const status = data?.status;
      if (status === "linked" || status === "already_linked") {
        session.step = "connected";
        delete session.email;
        delete session.supabaseUserId;

        return ctx.reply(
          `Готово! 🎉\n\n` +
          `Telegram успешно подключён к твоему Planner.\n\n` +
          `Теперь я смогу работать с твоими задачами, ` +
          `событиями, привычками и идеями.`
        );
      }

      if (status === "telegram_already_linked") {
        return ctx.reply("Этот Telegram уже подключён к другому Planner-аккаунту.");
      }

      if (status === "planner_already_linked") {
        return ctx.reply("Этот Planner уже подключён к другому Telegram-аккаунту.");
      }

      if (status === "link_conflict") {
        return ctx.reply("Не удалось завершить привязку из-за уже существующей связи. Обнови статус в Planner и попробуй снова.");
      }

      return ctx.reply("Код недействителен или истёк. Создай новый код в Planner → Профиль.");
    } catch (error) {
      console.error(`Telegram pairing failed (${String(error?.name || "UNKNOWN").slice(0, 64)}).`);
      return ctx.reply("Не удалось подключить Planner. Попробуй создать новый код и отправить его ещё раз.");
    }
  }

  // ───────────────────────────────────────────
  // Если пользователь уже подключён
  // ───────────────────────────────────────────

  if (session.step === "connected") {
    try {
      await ctx.sendChatAction("typing");
      const result = await runPlannerAssistant({ ai, ctx, text, session });
      await ctx.reply(result.answer);
    } catch (error) {
      console.error(`Planner assistant request failed (${String(error?.name || "UNKNOWN").slice(0, 64)}).`);

      await ctx.reply(
        "Не удалось получить ответ от AI 😔"
      );
    }

    return;
  }

  // Если сессия потерялась после перезапуска бота,
  // но Telegram уже привязан к аккаунту.
  const { data: linkedUser } = await supabase
    .from("telegram_users")
    .select("supabase_user_id")
    .eq("telegram_id", ctx.from.id)
    .maybeSingle();

  if (linkedUser) {
    session.step = "connected";
    delete session.email;
    delete session.supabaseUserId;

    return ctx.reply(
      "Я перезапустился и восстановил подключение к Planner 👍\n\n" +
      "Можешь продолжать."
    );
  }

  return ctx.reply(
    "Для начала подключи Planner командой /start."
  );
});

// ─────────────────────────────────────────────
// Start polling only when executed directly. Webhook handlers import the bot
// and call handleUpdate for each Telegram request.
if (require.main === module) {
  bot.launch();
  console.log("🤖 Милый Ублюдок запущен!");
  console.log("Напиши /start в Telegram.");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

module.exports = { bot, supabase };
