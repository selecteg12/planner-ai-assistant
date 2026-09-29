const test = require("node:test");
const assert = require("node:assert/strict");
const { runPlannerAssistant, confirmPlannerDeletion } = require("./ai-assistant");

function fakeCtx() {
  const calls = [];
  return {
    calls,
    from: { id: 123 },
    plannerReadTools: {
      async get_today(ctx, args) { calls.push({ name: "get_today", telegramId: ctx.from.id, args }); return { date: "2026-09-26", tasks: [{ title: "Send proposal" }] }; },
    },
    plannerTaskTools: {
      async delete_task(ctx, args) { calls.push({ name: "delete_task", telegramId: ctx.from.id, args }); return { deleted: true, task: { title: "Old task" } }; },
    },
  };
}

test("assistant executes a read tool and uses its result in the final answer", async () => {
  const ctx = fakeCtx();
  const replies = [
    { choices: [{ message: { content: null, tool_calls: [{ id: "call-1", function: { name: "get_today", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: "На сегодня есть задача: отправить предложение.", tool_calls: [] } }] },
  ];
  const ai = { chat: { completions: { async create() { return replies.shift(); } } } };
  const session = {};

  const result = await runPlannerAssistant({ ai, ctx, text: "Что у меня сегодня?", session, now: () => new Date("2026-09-26T06:00:00Z") });

  assert.match(result.answer, /предложение/);
  assert.equal(ctx.calls[0].telegramId, 123);
  assert.equal(session.aiHistory.length, 2);
});

test("destructive tool asks for confirmation before it can run", async () => {
  const ctx = fakeCtx();
  const ai = { chat: { completions: { async create() {
    return { choices: [{ message: { content: null, tool_calls: [{ id: "call-2", function: { name: "delete_task", arguments: '{"task_id":"11111111-1111-4111-8111-111111111111"}' } }] } }] };
  } } } };
  const session = {};
  const fixedNow = () => new Date("2026-09-26T06:00:00Z");

  const result = await runPlannerAssistant({ ai, ctx, text: "Удали старую задачу", session, now: fixedNow });
  assert.equal(result.confirmationRequired, true);
  assert.equal(ctx.calls.length, 0);

  const confirmed = await confirmPlannerDeletion({ ctx, session, text: "Да", now: fixedNow });
  assert.match(confirmed.answer, /удалил «Old task»/);
  assert.equal(ctx.calls[0].name, "delete_task");
});
