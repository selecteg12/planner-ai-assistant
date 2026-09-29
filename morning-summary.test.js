const test = require("node:test");
const assert = require("node:assert/strict");
const { formatMorningSummary, isInDeliveryWindow } = require("./morning-summary");

test("morning summary contains only supplied Planner data", () => {
  const message = formatMorningSummary({
    today: {
      date: "2026-09-25",
      events: [{ title: "Planning", start_at: "2026-09-25T05:30:00.000Z", end_at: "2026-09-25T06:00:00.000Z" }],
      tasks: [{ title: "Pay bill" }],
      overdue_tasks: [{ title: "Old task", deadline: "2026-09-24" }],
      habits: [{ title: "Read", completed: false }],
    },
    openTasks: [{ title: "Important", priority: "high", deadline: "2026-09-25" }],
    timeZone: "Europe/Moscow",
  });

  assert.match(message, /Planning/);
  assert.match(message, /Important/);
  assert.match(message, /Old task/);
  assert.match(message, /Pay bill/);
  assert.match(message, /Read — ещё не отмечена/);
  assert.doesNotMatch(message, /No invented task/);
});

test("delivery window uses the configured local time", () => {
  const settings = { timeZone: "Europe/Moscow", hour: 8, minute: 0, windowMinutes: 60 };
  assert.equal(isInDeliveryWindow(new Date("2026-09-25T05:00:00.000Z"), settings), true);
  assert.equal(isInDeliveryWindow(new Date("2026-09-25T06:00:00.000Z"), settings), false);
  assert.equal(isInDeliveryWindow(new Date("2026-09-25T04:59:00.000Z"), settings), false);
});
