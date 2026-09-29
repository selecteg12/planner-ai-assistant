const { dateKeyInZone } = require("./read-tools");
const { plannerFunctionTools, DESTRUCTIVE_TOOLS, createToolDispatcher } = require("./ai-tools");

const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY_MESSAGES = 12;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const dispatch = createToolDispatcher();

function systemPrompt(now, timeZone) {
  return [
    "Ты личный AI-помощник Planner. Отвечай по-русски естественно и кратко.",
    "Planner — источник истины для задач, событий, привычек, идей и напоминаний.",
    "Для вопросов о данных Planner сначала вызови подходящий инструмент и отвечай только по его результату. Не придумывай данные и не утверждай, что изменение выполнено без успешного результата инструмента.",
    "Изменяй данные только по ясной прямой просьбе пользователя. Если не хватает обязательных сведений (например, даты или времени), задай уточняющий вопрос вместо догадки.",
    "Даты передавай в формате YYYY-MM-DD. Дата сегодня в часовом поясе пользователя: " + dateKeyInZone(now, timeZone) + ". Часовой пояс: " + timeZone + ".",
    "При создании событий передавай даты и время с часовым поясом в ISO 8601. Если пользователь назвал местное время, используй указанный часовой пояс.",
    "Перед удалением бот запросит отдельное подтверждение; не обходи этот шаг.",
    "Не показывай внутренние идентификаторы, если пользователь не просит их.",
  ].join(" ");
}

function safeToolError(error) {
  if (error?.code === "TELEGRAM_NOT_LINKED") return "Telegram ещё не привязан к Planner. Привяжите аккаунт командой /start.";
  if (["TASK_NOT_FOUND", "EVENT_NOT_FOUND", "HABIT_NOT_FOUND", "IDEA_NOT_FOUND", "REMINDER_NOT_FOUND"].includes(error?.code)) {
    return "Запись не найдена в Planner. Сначала перечитай список и уточни, какую именно запись нужно изменить.";
  }
  if (error instanceof TypeError) return error.message;
  return "Не удалось выполнить запрос к Planner. Попробуй ещё раз.";
}

function compactToolResult(value) {
  function shrink(item) {
    if (Array.isArray(item)) {
      if (item.length > 30) return { items: item.slice(0, 30).map(shrink), omitted: item.length - 30 };
      return item.map(shrink);
    }
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, shrink(child)]));
    }
    return item;
  }

  const safe = JSON.stringify(shrink(value));
  if (safe.length <= 18_000) return safe;
  return JSON.stringify({ truncated: true, message: "Ответ слишком объёмный. Попроси пользователя уточнить период или фильтр." });
}

function parseToolCalls(message) {
  return (message.tool_calls || []).map((call) => {
    let args;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      args = null;
    }
    return { id: call.id, name: call.function.name, args };
  });
}

async function executeToolCall(ctx, call) {
  if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) {
    return { error: "Аргументы инструмента должны быть JSON-объектом. Уточни недостающие данные у пользователя." };
  }
  try {
    return await dispatch(ctx, call.name, call.args);
  } catch (error) {
    return { error: safeToolError(error) };
  }
}

async function runPlannerAssistant({ ai, ctx, text, session, now = () => new Date() }) {
  const timeZone = process.env.PLANNER_TIMEZONE || "Europe/Moscow";
  const history = Array.isArray(session.aiHistory) ? session.aiHistory : [];
  const messages = [
    { role: "system", content: systemPrompt(now(), timeZone) },
    ...history,
    { role: "user", content: text },
  ];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const response = await ai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
      messages,
      ...(round < MAX_TOOL_ROUNDS ? { tools: plannerFunctionTools, tool_choice: "auto", parallel_tool_calls: false } : {}),
    });
    const assistantMessage = response.choices?.[0]?.message;
    if (!assistantMessage) throw new Error("The AI provider returned an empty response");

    const calls = parseToolCalls(assistantMessage);
    if (!calls.length) {
      const answer = String(assistantMessage.content || "Не получилось сформировать ответ.").slice(0, 3900);
      session.aiHistory = [...history, { role: "user", content: text }, { role: "assistant", content: answer }]
        .slice(-MAX_HISTORY_MESSAGES);
      return { answer };
    }

    const destructive = calls.find((call) => DESTRUCTIVE_TOOLS.has(call.name));
    if (destructive) {
      if (!destructive.args || typeof destructive.args !== "object") {
        messages.push({ role: "assistant", content: "Не удалось определить, какую запись нужно удалить. Запроси уточнение." });
        continue;
      }
      session.pendingPlannerDeletion = {
        name: destructive.name,
        args: destructive.args,
        originalText: text,
        createdAt: now().getTime(),
      };
      return { confirmationRequired: true, answer: "Подтвердить удаление выбранной записи из Planner? Ответь «Да» или «Нет»." };
    }

    messages.push({
      role: "assistant",
      content: assistantMessage.content || null,
      tool_calls: (assistantMessage.tool_calls || []).map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments },
      })),
    });
    for (const call of calls) {
      const result = await executeToolCall(ctx, call);
      messages.push({ role: "tool", tool_call_id: call.id, content: compactToolResult(result) });
    }
  }

  throw new Error("The AI assistant reached its tool-call limit");
}

async function confirmPlannerDeletion({ ctx, session, text, now = () => new Date() }) {
  const pending = session.pendingPlannerDeletion;
  if (!pending) return null;

  const response = text.trim().toLocaleLowerCase("ru-RU");
  const yes = /^(да|подтверждаю|подтвердить)(?:[.! ]|$)/u.test(response);
  const no = /^(нет|отмена|не удаляй)(?:[.! ]|$)/u.test(response);
  if (now().getTime() - pending.createdAt > CONFIRMATION_TTL_MS) {
    delete session.pendingPlannerDeletion;
    return { handled: true, answer: "Подтверждение устарело. Запись не удалена; если нужно, попроси удалить её ещё раз." };
  }
  if (!yes && !no) {
    return { handled: true, answer: "Я пока ничего не удалял. Ответь «Да» для подтверждения или «Нет» для отмены." };
  }

  delete session.pendingPlannerDeletion;
  if (no) {
    const answer = "Хорошо, удаление отменено. Запись осталась в Planner.";
    session.aiHistory = [...(session.aiHistory || []), { role: "user", content: pending.originalText }, { role: "assistant", content: answer }]
      .slice(-MAX_HISTORY_MESSAGES);
    return { handled: true, answer };
  }

  const result = await executeToolCall(ctx, pending);
  let answer;
  if (result?.deleted) {
    answer = `Готово, удалил «${result.task?.title || result.event?.title || result.idea?.title || "запись"}» из Planner.`;
  } else {
    answer = `Удаление не выполнено: ${result?.error || "запись не найдена"}`;
  }
  session.aiHistory = [...(session.aiHistory || []), { role: "user", content: pending.originalText }, { role: "assistant", content: answer }]
    .slice(-MAX_HISTORY_MESSAGES);
  return { handled: true, answer };
}

module.exports = { runPlannerAssistant, confirmPlannerDeletion, compactToolResult, safeToolError };
