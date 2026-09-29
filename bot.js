require("dotenv").config({ path: ".env.local" });

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

// OTP verification must not replace the privileged client's auth session.
const supabaseAuth = createClient(
  supabaseUrl,
  requireEnv("SUPABASE_ANON_KEY"),
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

  session.step = "waiting_email";

  await ctx.reply(
    `Привет, ${ctx.from.first_name || "человек"} 👋\n\n` +
    `Я — твой личный помощник Planner.\n\n` +
    `Чтобы подключить твой Planner к Telegram, ` +
    `отправь email, с которым ты зарегистрирован в Planner.`
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

  // Команды отдельно обрабатываются Telegram.
  if (text.startsWith("/")) return;

  const pendingDeletion = await confirmPlannerDeletion({ ctx, session, text });
  if (pendingDeletion?.handled) return ctx.reply(pendingDeletion.answer);

  // ───────────────────────────────────────────
  // ШАГ 1 — ждём email
  // ───────────────────────────────────────────

  if (session.step === "waiting_email") {
    const email = text.toLowerCase();

    // Простая проверка email.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return ctx.reply(
        "Похоже, это не email.\n\n" +
        "Например:\n" +
        "name@example.com"
      );
    }

    try {
      await ctx.sendChatAction("typing");

      // Проверяем, существует ли пользователь с таким email.
      let page = 1;
      let user = null;

      while (!user) {
        const { data, error } = await supabase.auth.admin.listUsers({
          page,
          perPage: 1000,
        });

        if (error) {
          console.error("Ошибка поиска пользователя:", error);
          return ctx.reply("Не удалось проверить email. Попробуй ещё раз.");
        }

        user = data.users.find(
          (candidate) => candidate.email?.toLowerCase() === email
        ) || null;

        if (user || data.users.length < 1000) break;
        page += 1;
      }

      if (!user) {
        return ctx.reply(
          "Пользователь с таким email не найден.\n\n" +
          "Убедись, что используешь тот email, " +
          "с которым зарегистрирован в Planner."
        );
      }

      // Сохраняем email и user_id в сессии.
      session.email = email;
      session.supabaseUserId = user.id;
      session.step = "waiting_code";

      // Отправляем OTP-код.
      const { error: otpError } = await supabaseAuth.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
        },
      });

      if (otpError) {
        console.error("Ошибка отправки OTP:", otpError);

        session.step = "waiting_email";
        session.email = null;
        session.supabaseUserId = null;

        return ctx.reply(
          "Не получилось отправить код на email.\n\n" +
          "Попробуй ещё раз."
        );
      }

      return ctx.reply(
        `Код отправлен на ${email} 📩\n\n` +
        `Проверь почту и отправь сюда код из письма.`
      );
    } catch (error) {
      console.error("Ошибка авторизации:", error);
      return ctx.reply("Произошла ошибка. Попробуй ещё раз.");
    }
  }

  // ───────────────────────────────────────────
  // ШАГ 2 — ждём OTP
  // ───────────────────────────────────────────

  if (session.step === "waiting_code") {
    const code = text.replace(/\s/g, "");

    if (!/^\d{6}$/.test(code)) {
      return ctx.reply(
        "Код должен состоять из 6 цифр.\n\n" +
        "Отправь код из письма ещё раз."
      );
    }

    try {
      await ctx.sendChatAction("typing");

      const { data, error } = await supabaseAuth.auth.verifyOtp({
        email: session.email,
        token: code,
        type: "email",
      });

      if (error) {
        console.error("Ошибка проверки OTP:", error);

        return ctx.reply(
          "Код неверный или уже истёк.\n\n" +
          "Попробуй получить новый код через /start."
        );
      }

      const supabaseUserId = data.user?.id || session.supabaseUserId;

      if (!supabaseUserId || supabaseUserId !== session.supabaseUserId) {
        session.step = "waiting_email";
        session.email = null;
        session.supabaseUserId = null;

        return ctx.reply(
          "Не удалось определить пользователя Planner."
        );
      }

      // Do not silently transfer a Planner account from another Telegram ID.
      const { data: existingLink, error: lookupError } = await supabase
        .from("telegram_users")
        .select("telegram_id")
        .eq("supabase_user_id", supabaseUserId)
        .maybeSingle();

      if (lookupError) {
        console.error("Ошибка проверки привязки Planner:", lookupError);
        return ctx.reply("Не удалось проверить привязку. Попробуй ещё раз.");
      }

      if (existingLink && String(existingLink.telegram_id) !== String(ctx.from.id)) {
        session.step = "waiting_email";
        session.email = null;
        session.supabaseUserId = null;

        return ctx.reply(
          "Этот Planner уже подключён к другому Telegram-аккаунту. " +
          "Обратись в поддержку, чтобы изменить привязку."
        );
      }

      // Insert only: a concurrent or existing Telegram link must not be overwritten.
      const { error: linkError } = await supabase
        .from("telegram_users")
        .insert({
          telegram_id: ctx.from.id,
          supabase_user_id: supabaseUserId,
          telegram_username: ctx.from.username || null,
          telegram_first_name: ctx.from.first_name || null,
        });

      if (linkError) {
        console.error("Ошибка привязки Telegram:", linkError);

        return ctx.reply(
          "Email подтверждён, но не удалось привязать Telegram.\n\n" +
          "Попробуй ещё раз."
        );
      }

      session.step = "connected";
      delete session.email;
      delete session.supabaseUserId;

      return ctx.reply(
        `Готово! 🎉\n\n` +
        `Telegram успешно подключён к твоему Planner.\n\n` +
        `Теперь я смогу работать с твоими задачами, ` +
        `событиями, привычками и идеями.`
      );
    } catch (error) {
      console.error("Ошибка подтверждения:", error);
      return ctx.reply("Произошла ошибка. Попробуй ещё раз.");
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
