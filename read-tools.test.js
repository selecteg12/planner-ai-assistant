const test = require("node:test");
const assert = require("node:assert/strict");
const { createReadTools, weekStartFor, expandEvents } = require("./read-tools");

class FakeQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.filters = [];
    this.orders = [];
  }

  select() { return this; }
  eq(column, value) { this.filters.push(["eq", column, value]); return this; }
  gt(column, value) { this.filters.push(["gt", column, value]); return this; }
  gte(column, value) { this.filters.push(["gte", column, value]); return this; }
  lt(column, value) { this.filters.push(["lt", column, value]); return this; }
  lte(column, value) { this.filters.push(["lte", column, value]); return this; }
  order(column, options = {}) { this.orders.push([column, options]); return this; }

  async maybeSingle() {
    const result = this.execute();
    if (result.data.length > 1) return { data: null, error: { code: "MULTIPLE_ROWS" } };
    return { data: result.data[0] || null, error: null };
  }

  execute() {
    this.client.queries.push({ table: this.table, filters: this.filters });
    let data = (this.client.seed[this.table] || []).filter((row) =>
      this.filters.every(([operator, column, value]) => {
        const actual = row[column];
        if (operator === "eq") return actual === value;
        if (operator === "gt") return actual != null && actual > value;
        if (operator === "gte") return actual != null && actual >= value;
        if (operator === "lt") return actual != null && actual < value;
        if (operator === "lte") return actual != null && actual <= value;
        return false;
      })
    );

    for (const [column, options] of [...this.orders].reverse()) {
      data = [...data].sort((a, b) => {
        const left = a[column];
        const right = b[column];
        if (left == null || right == null) {
          if (left == null && right == null) return 0;
          return left == null === Boolean(options.nullsFirst) ? -1 : 1;
        }
        const order = left < right ? -1 : left > right ? 1 : 0;
        return options.ascending === false ? -order : order;
      });
    }

    return { data, error: null };
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
}

function makeClient(seed) {
  return {
    seed,
    queries: [],
    from(table) { return new FakeQuery(this, table); },
  };
}

function fixture() {
  return makeClient({
    telegram_users: [
      { telegram_id: 101, supabase_user_id: "user-a" },
      { telegram_id: 202, supabase_user_id: "user-b" },
    ],
    events: [
      { id: "event-a", user_id: "user-a", title: "Own", start_at: "2026-09-25T10:00:00Z", end_at: "2026-09-25T11:00:00Z" },
      { id: "event-b", user_id: "user-b", title: "Other", start_at: "2026-09-25T12:00:00Z", end_at: "2026-09-25T13:00:00Z" },
    ],
    tasks: [
      { id: "today", user_id: "user-a", title: "Today", deadline: "2026-09-25", done: false, created_at: "2026-09-20T00:00:00Z" },
      { id: "overdue", user_id: "user-a", title: "Overdue", deadline: "2026-09-24", done: false, created_at: "2026-09-20T00:00:00Z" },
      { id: "done-overdue", user_id: "user-a", title: "Done", deadline: "2026-09-23", done: true, created_at: "2026-09-20T00:00:00Z" },
      { id: "future", user_id: "user-a", title: "Future", deadline: "2026-09-26", done: false, created_at: "2026-09-20T00:00:00Z" },
      { id: "other", user_id: "user-b", title: "Other", deadline: "2026-09-25", done: false, created_at: "2026-09-20T00:00:00Z" },
    ],
    habits: [
      { id: "habit-a", user_id: "user-a", title: "Read", created_at: "2026-09-01T00:00:00Z" },
      { id: "habit-b", user_id: "user-b", title: "Other habit", created_at: "2026-09-01T00:00:00Z" },
    ],
    habit_completions: [
      { id: "completion-a", user_id: "user-a", habit_id: "habit-a", completed_date: "2026-09-25" },
      { id: "completion-b", user_id: "user-b", habit_id: "habit-b", completed_date: "2026-09-25" },
    ],
  });
}

function createTools(client) {
  return createReadTools({
    supabase: client,
    timeZone: "UTC",
    now: () => new Date("2026-09-25T12:00:00Z"),
  });
}

test("get_today returns only linked user's events, tasks, overdue tasks and habit state", async () => {
  const client = fixture();
  const result = await createTools(client).get_today({ from: { id: 101 } });

  assert.equal(result.date, "2026-09-25");
  assert.deepEqual(result.events.map((row) => row.id), ["event-a"]);
  assert.deepEqual(result.tasks.map((row) => row.id), ["today"]);
  assert.deepEqual(result.overdue_tasks.map((row) => row.id), ["overdue"]);
  assert.equal(result.habits.length, 1);
  assert.equal(result.habits[0].completed, true);
  assert.ok(client.queries.filter((query) => query.table !== "telegram_users")
    .every((query) => query.filters.some(([op, column, value]) => op === "eq" && column === "user_id" && value === "user-a")));
});

test("get_tasks supports today, future, overdue and all-open filters", async () => {
  const client = fixture();
  const tools = createTools(client);
  const ctx = { from: { id: 101 } };

  assert.deepEqual((await tools.get_tasks(ctx, { filter: "today" })).tasks.map((row) => row.id), ["today"]);
  assert.deepEqual((await tools.get_tasks(ctx, { filter: "future" })).tasks.map((row) => row.id), ["future"]);
  assert.deepEqual((await tools.get_tasks(ctx, { filter: "overdue" })).tasks.map((row) => row.id), ["overdue"]);
  assert.deepEqual((await tools.get_tasks(ctx, { filter: "open" })).tasks.map((row) => row.id).sort(), ["future", "overdue", "today"]);
  await assert.rejects(tools.get_tasks(ctx, { filter: "user-b" }), /Unsupported task filter/);
});

test("get_events validates the range and includes only the linked user's events", async () => {
  const client = fixture();
  const tools = createTools(client);
  const result = await tools.get_events({ from: { id: 101 } }, {
    start_date: "2026-09-25",
    end_date: "2026-09-25",
  });

  assert.deepEqual(result.events.map((row) => row.id), ["event-a"]);
  await assert.rejects(tools.get_events({ from: { id: 101 } }, {
    start_date: "2026-09-26",
    end_date: "2026-09-25",
  }), /start_date must be on or before end_date/);
});

test("get_today uses the configured timezone and includes events overlapping local midnight", async () => {
  const client = fixture();
  client.seed.events.push(
    { id: "before-day", user_id: "user-a", title: "Before", start_at: "2026-09-25T20:00:00Z", end_at: "2026-09-25T20:30:00Z" },
    { id: "spans-midnight", user_id: "user-a", title: "Spans", start_at: "2026-09-25T20:30:00Z", end_at: "2026-09-25T21:30:00Z" }
  );
  const tools = createReadTools({
    supabase: client,
    timeZone: "Europe/Moscow",
    now: () => new Date("2026-09-25T22:00:00Z"),
  });
  const result = await tools.get_today({ from: { id: 101 } });

  assert.equal(result.date, "2026-09-26");
  assert.ok(result.events.some((event) => event.id === "spans-midnight"));
  assert.ok(!result.events.some((event) => event.id === "before-day"));
});

test("read tools expand daily recurring events from their stored series into the requested date", async () => {
  const client = fixture();
  client.seed.events.push({
    id: "daily-series", user_id: "user-a", title: "Daily standup",
    start_at: "2026-09-23T09:00:00.000Z", end_at: "2026-09-23T09:30:00.000Z",
    recurrence: "daily", recurrence_end_date: "2026-09-27",
  });

  const result = await createTools(client).get_today({ from: { id: 101 } }, { date: "2026-09-25" });
  const occurrence = result.events.find((event) => event.id === "daily-series");
  assert.equal(occurrence.start_at, "2026-09-25T09:00:00.000Z");
  assert.equal(occurrence.occurrence_id, "daily-series-2026-09-25");
  assert.ok(client.queries.filter((query) => query.table === "events")
    .every((query) => query.filters.some(([op, column, value]) => op === "eq" && column === "user_id" && value === "user-a")));
});

test("monthly event expansion follows Planner's clamped month stepping", () => {
  const events = expandEvents([{
    id: "month-end", title: "Month end", start_at: "2026-01-31T09:00:00.000Z",
    end_at: "2026-01-31T09:30:00.000Z", recurrence: "monthly", recurrence_end_date: "2026-04-30",
  }], "2026-03-01", "2026-03-31", "UTC");

  assert.deepEqual(events.map((event) => event.start_at), ["2026-03-28T09:00:00.000Z"]);
});

test("get_week uses Monday through Sunday and filters every Planner table by owner", async () => {
  const client = fixture();
  const result = await createTools(client).get_week({ from: { id: 101 } }, { date: "2026-09-25" });

  assert.equal(result.start_date, "2026-09-21");
  assert.equal(result.end_date, "2026-09-27");
  assert.deepEqual(result.events.map((row) => row.id), ["event-a"]);
  assert.deepEqual(result.tasks.map((row) => row.id).sort(), ["done-overdue", "future", "overdue", "today"]);
  assert.ok(client.queries.filter((query) => query.table !== "telegram_users")
    .every((query) => query.filters.some(([op, column, value]) => op === "eq" && column === "user_id" && value === "user-a")));
});

test("read tools reject unlinked accounts and ignore caller-supplied user ids", async () => {
  const client = fixture();
  const tools = createTools(client);

  await assert.rejects(tools.get_today({ from: { id: 303 } }), { code: "TELEGRAM_NOT_LINKED" });
  const result = await tools.get_tasks({ from: { id: 101 } }, { user_id: "user-b" });
  assert.deepEqual(result.tasks.map((row) => row.id).sort(), ["future", "overdue", "today"]);
  assert.ok(client.queries.filter((query) => query.table !== "telegram_users")
    .every((query) => query.filters.some(([op, column, value]) => op === "eq" && column === "user_id" && value === "user-a")));
  assert.equal(weekStartFor("2026-09-27"), "2026-09-21");
});
