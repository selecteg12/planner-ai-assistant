function schema(properties = {}, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function string(description, extra = {}) {
  return { type: "string", description, ...extra };
}

function tool(name, description, parameters) {
  return { type: "function", function: { name, description, parameters } };
}

const uuid = string("UUID записи Planner", { format: "uuid" });
const isoDate = string("Локальная дата в формате YYYY-MM-DD", { pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const isoTimestamp = string("Дата и время ISO 8601 с часовым поясом");

const plannerFunctionTools = [
  tool("get_today", "Прочитать события, задачи, просроченные задачи и привычки на указанную дату (по умолчанию сегодня).", schema({ date: isoDate })),
  tool("get_tasks", "Прочитать задачи Planner. Используй фильтр today, overdue, future, open или all.", schema({
    filter: { type: "string", enum: ["today", "overdue", "future", "open", "all"] }, date: isoDate,
  })),
  tool("get_events", "Прочитать события Planner за период включительно.", schema({ start_date: isoDate, end_date: isoDate }, ["start_date", "end_date"])),
  tool("get_habits", "Прочитать привычки и их отметки на дату (по умолчанию сегодня).", schema({ date: isoDate })),
  tool("get_week", "Прочитать события, задачи и привычки на неделю, содержащую указанную дату.", schema({ date: isoDate })),

  tool("create_task", "Создать задачу Planner по прямой просьбе пользователя.", schema({
    title: string("Краткое название задачи"), note: string("Подробности", { type: ["string", "null"] }),
    deadline: { ...isoDate, type: ["string", "null"] },
    priority: { type: "string", enum: ["low", "medium", "high"] },
  }, ["title"])),
  tool("update_task", "Изменить только переданные поля существующей задачи.", schema({
    task_id: uuid, title: string("Новое название"), note: string("Новые подробности", { type: ["string", "null"] }),
    deadline: { ...isoDate, type: ["string", "null"] }, priority: { type: "string", enum: ["low", "medium", "high"] },
  }, ["task_id"])),
  tool("complete_task", "Отметить задачу выполненной.", schema({ task_id: uuid }, ["task_id"])),
  tool("delete_task", "Удалить задачу. Перед выполнением бот запросит отдельное подтверждение пользователя.", schema({ task_id: uuid }, ["task_id"])),

  tool("create_event", "Создать событие Planner. При повторении укажи recurrence_end_date.", schema({
    title: string("Название события"), start_at: isoTimestamp, end_at: isoTimestamp,
    color: { type: "string", enum: ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"] },
    recurrence: { type: "string", enum: ["none", "daily", "weekly", "monthly", "yearly"] },
    recurrence_end_date: isoDate,
  }, ["title", "start_at", "end_at"])),
  tool("update_event", "Изменить переданные поля существующего события.", schema({
    event_id: uuid, title: string("Новое название"), start_at: isoTimestamp, end_at: isoTimestamp,
    color: { type: "string", enum: ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"] },
    recurrence: { type: "string", enum: ["none", "daily", "weekly", "monthly", "yearly"] }, recurrence_end_date: isoDate,
  }, ["event_id"])),
  tool("delete_event", "Удалить событие. Перед выполнением бот запросит отдельное подтверждение пользователя.", schema({ event_id: uuid }, ["event_id"])),

  tool("complete_habit", "Отметить привычку выполненной на указанную дату (по умолчанию сегодня).", schema({ habit_id: uuid, date: isoDate }, ["habit_id"])),
  tool("undo_habit_completion", "Снять отметку выполнения привычки за дату (по умолчанию сегодня).", schema({ habit_id: uuid, date: isoDate }, ["habit_id"])),

  tool("create_idea", "Сохранить идею пользователя в Planner.", schema({ title: string("Текст идеи"), category: string("Категория идеи", { type: ["string", "null"] }) }, ["title"])),
  tool("get_ideas", "Прочитать идеи. Архивные включаются только по явной просьбе.", schema({ include_archived: { type: "boolean" } })),
  tool("update_idea", "Изменить название или категорию идеи.", schema({ idea_id: uuid, title: string("Новое название"), category: string("Категория", { type: ["string", "null"] }) }, ["idea_id"])),
  tool("archive_idea", "Архивировать или восстановить идею.", schema({ idea_id: uuid, archived: { type: "boolean", description: "true — архивировать; false — восстановить" } }, ["idea_id"])),
  tool("delete_idea", "Удалить идею. Перед выполнением бот запросит отдельное подтверждение пользователя.", schema({ idea_id: uuid }, ["idea_id"])),

  tool("create_reminder", "Создать одноразовое напоминание. Время должно быть указано в ISO 8601 с часовым поясом.", schema({
    text: string("Текст напоминания"), remind_at: isoTimestamp,
  }, ["text", "remind_at"])),
  tool("cancel_reminder", "Отменить ожидающее напоминание.", schema({ reminder_id: uuid }, ["reminder_id"])),
];

const DESTRUCTIVE_TOOLS = new Set(["delete_task", "delete_event", "delete_idea"]);

function createToolDispatcher() {
  const methods = {
    get_today: "plannerReadTools", get_tasks: "plannerReadTools", get_events: "plannerReadTools",
    get_habits: "plannerReadTools", get_week: "plannerReadTools",
    create_task: "plannerTaskTools", update_task: "plannerTaskTools", complete_task: "plannerTaskTools", delete_task: "plannerTaskTools",
    create_event: "plannerEventTools", update_event: "plannerEventTools", delete_event: "plannerEventTools",
    complete_habit: "plannerHabitTools", undo_habit_completion: "plannerHabitTools",
    create_idea: "plannerIdeaTools", get_ideas: "plannerIdeaTools", update_idea: "plannerIdeaTools", delete_idea: "plannerIdeaTools", archive_idea: "plannerIdeaTools",
    create_reminder: "plannerReminderTools", cancel_reminder: "plannerReminderTools",
  };

  return async function dispatch(ctx, name, args) {
    const contextProperty = methods[name];
    const method = contextProperty && ctx[contextProperty]?.[name];
    if (typeof method !== "function") throw new Error("Unsupported Planner tool");
    return method(ctx, args);
  };
}

module.exports = { plannerFunctionTools, DESTRUCTIVE_TOOLS, createToolDispatcher };
