const test = require("node:test");
const assert = require("node:assert/strict");
const { createTaskTools } = require("./task-tools");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";

function matches(row, filters) {
  return filters.every(([operator, column, value]) => {
    const actual = row[column];
    if (operator === "eq") return actual === value;
    if (operator === "gt") return actual != null && actual > value;
    if (operator === "gte") return actual != null && actual >= value;
    if (operator === "lt") return actual != null && actual < value;
    if (operator === "lte") return actual != null && actual <= value;
    return false;
  });
}

class FakeQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.operation = "select";
    this.filters = [];
    this.selected = null;
  }

  select(fields) { this.selected = fields; return this; }
  insert(payload) { this.operation = "insert"; this.payload = payload; return this; }
  update(payload) { this.operation = "update"; this.payload = payload; return this; }
  delete() { this.operation = "delete"; return this; }
  eq(column, value) { this.filters.push(["eq", column, value]); return this; }
  gt(column, value) { this.filters.push(["gt", column, value]); return this; }
  gte(column, value) { this.filters.push(["gte", column, value]); return this; }
  lt(column, value) { this.filters.push(["lt", column, value]); return this; }
  lte(column, value) { this.filters.push(["lte", column, value]); return this; }

  project(row) {
    if (!this.selected || this.selected === "*") return { ...row };
    return Object.fromEntries(this.selected.split(",").map((field) => [field.trim(), row[field.trim()]]));
  }

  execute() {
    this.client.calls.push({
      table: this.table,
      operation: this.operation,
      filters: [...this.filters],
      payload: this.payload,
    });
    const rows = this.client.seed[this.table] || (this.client.seed[this.table] = []);

    if (this.operation === "insert") {
      const row = {
        id: this.client.nextId(),
        created_at: this.client.createdAt,
        done: false,
        completed_at: null,
        ...this.payload,
      };
      rows.push(row);
      return { data: [this.project(row)], error: null };
    }

    const matched = rows.filter((row) => matches(row, this.filters));
    if (this.operation === "update") {
      for (const row of matched) Object.assign(row, this.payload);
      return { data: matched.map((row) => this.project(row)), error: null };
    }
    if (this.operation === "delete") {
      this.client.seed[this.table] = rows.filter((row) => !matches(row, this.filters));
      return { data: matched.map((row) => this.project(row)), error: null };
    }
    return { data: matched.map((row) => this.project(row)), error: null };
  }

  async maybeSingle() {
    const result = this.execute();
    if (result.data.length > 1) return { data: null, error: { code: "MULTIPLE_ROWS" } };
    return { data: result.data[0] || null, error: null };
  }

  async single() {
    const result = this.execute();
    return result.data.length === 1
      ? { data: result.data[0], error: null }
      : { data: null, error: { code: "SINGLE_ROW_EXPECTED" } };
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
}

function makeClient() {
  let sequence = 0;
  return {
    seed: {
      telegram_users: [
        { telegram_id: 101, supabase_user_id: USER_A },
        { telegram_id: 202, supabase_user_id: USER_B },
      ],
      tasks: [
        { id: TASK_A, user_id: USER_A, title: "Own task", note: null, deadline: null, priority: "medium", done: false, completed_at: null, created_at: "2026-09-20T00:00:00.000Z" },
        { id: TASK_B, user_id: USER_B, title: "Other task", note: null, deadline: null, priority: "low", done: false, completed_at: null, created_at: "2026-09-20T00:00:00.000Z" },
      ],
    },
    calls: [],
    createdAt: "2026-09-25T12:00:00.000Z",
    nextId() {
      sequence += 1;
      return `33333333-3333-4333-8333-${String(sequence).padStart(12, "0")}`;
    },
    from(table) { return new FakeQuery(this, table); },
  };
}

function toolsFor(client) {
  return createTaskTools({ supabase: client, now: () => new Date("2026-09-25T12:00:00.000Z") });
}

const ctxA = { from: { id: 101 } };

test("create_task inserts only supported fields for the verified Telegram user", async () => {
  const client = makeClient();
  const result = await toolsFor(client).create_task(ctxA, {
    title: "  Finish lab  ",
    note: "  Draft report  ",
    deadline: "2026-09-30",
    priority: "high",
  });

  assert.equal(result.created, true);
  assert.equal(result.task.title, "Finish lab");
  assert.equal(result.task.user_id, undefined);
  assert.equal(client.seed.tasks.at(-1).user_id, USER_A);
  assert.equal(client.seed.tasks.at(-1).done, false);
  assert.equal(client.calls.find((call) => call.operation === "insert").payload.user_id, USER_A);
});

test("create_task rejects a caller-supplied owner and invalid priority or date", async () => {
  const tools = toolsFor(makeClient());
  await assert.rejects(tools.create_task(ctxA, { title: "x", user_id: USER_B }), /Unsupported task field/);
  await assert.rejects(tools.create_task(ctxA, { title: "x", priority: "urgent" }), /priority must be/);
  await assert.rejects(tools.create_task(ctxA, { title: "x", deadline: "2026-02-30" }), /valid calendar date/);
});

test("update_task scopes by both task id and verified owner", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  const result = await tools.update_task(ctxA, { task_id: TASK_A, deadline: "2026-10-01", priority: "low" });

  assert.equal(result.updated, true);
  assert.equal(client.seed.tasks[0].deadline, "2026-10-01");
  assert.equal(client.seed.tasks[0].priority, "low");
  const updateCall = client.calls.find((call) => call.operation === "update");
  assert.ok(updateCall.filters.some(([op, key, value]) => op === "eq" && key === "id" && value === TASK_A));
  assert.ok(updateCall.filters.some(([op, key, value]) => op === "eq" && key === "user_id" && value === USER_A));

  await assert.rejects(tools.update_task(ctxA, { task_id: TASK_B, title: "Take over" }), { code: "TASK_NOT_FOUND" });
  assert.equal(client.seed.tasks[1].title, "Other task");
});

test("complete_task is owner-scoped and idempotent", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  const first = await tools.complete_task(ctxA, { task_id: TASK_A });
  const second = await tools.complete_task(ctxA, { task_id: TASK_A });

  assert.equal(first.completed, true);
  assert.equal(first.already_completed, false);
  assert.equal(second.already_completed, true);
  assert.equal(client.seed.tasks[0].done, true);
  assert.equal(client.seed.tasks[0].completed_at, "2026-09-25T12:00:00.000Z");
  await assert.rejects(tools.complete_task(ctxA, { task_id: TASK_B }), { code: "TASK_NOT_FOUND" });
  assert.equal(client.seed.tasks[1].done, false);
});

test("delete_task cannot delete another Planner user's task", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  await assert.rejects(tools.delete_task(ctxA, { task_id: TASK_B }), { code: "TASK_NOT_FOUND" });
  assert.ok(client.seed.tasks.some((task) => task.id === TASK_B));

  const result = await tools.delete_task(ctxA, { task_id: TASK_A });
  assert.equal(result.deleted, true);
  assert.equal(result.task.title, "Own task");
  assert.deepEqual(client.seed.tasks.map((task) => task.id), [TASK_B]);
});
