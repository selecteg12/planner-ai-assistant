const test = require("node:test");
const assert = require("node:assert/strict");
const { createHabitTools } = require("./habit-tools");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HABIT_A = "11111111-1111-4111-8111-111111111111";
const HABIT_B = "22222222-2222-4222-8222-222222222222";

function matches(row, filters) {
  return filters.every(([operator, column, value]) => operator === "eq" && row[column] === value);
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
  delete() { this.operation = "delete"; return this; }
  eq(column, value) { this.filters.push(["eq", column, value]); return this; }

  project(row) {
    if (!this.selected || this.selected === "*") return { ...row };
    return Object.fromEntries(this.selected.split(",").map((field) => [field.trim(), row[field.trim()]]));
  }

  execute() {
    this.client.calls.push({ table: this.table, operation: this.operation, filters: [...this.filters], payload: this.payload });
    const rows = this.client.seed[this.table] || (this.client.seed[this.table] = []);
    if (this.operation === "insert") {
      const duplicate = rows.some((row) => row.habit_id === this.payload.habit_id && row.completed_date === this.payload.completed_date);
      if (duplicate) return { data: null, error: { code: "23505" } };
      const row = { id: this.client.nextId(), created_at: this.client.createdAt, ...this.payload };
      rows.push(row);
      return { data: [this.project(row)], error: null };
    }
    const found = rows.filter((row) => matches(row, this.filters));
    if (this.operation === "delete") {
      this.client.seed[this.table] = rows.filter((row) => !matches(row, this.filters));
      return { data: found.map((row) => this.project(row)), error: null };
    }
    return { data: found.map((row) => this.project(row)), error: null };
  }

  async maybeSingle() {
    const result = this.execute();
    if (result.data?.length > 1) return { data: null, error: { code: "MULTIPLE_ROWS" } };
    return { data: result.data?.[0] || null, error: result.error };
  }

  async single() {
    const result = this.execute();
    if (result.error) return { data: null, error: result.error };
    return result.data.length === 1
      ? { data: result.data[0], error: null }
      : { data: null, error: { code: "SINGLE_ROW_EXPECTED" } };
  }

  then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
}

function makeClient() {
  let sequence = 0;
  return {
    seed: {
      telegram_users: [
        { telegram_id: 101, supabase_user_id: USER_A },
        { telegram_id: 202, supabase_user_id: USER_B },
      ],
      habits: [
        { id: HABIT_A, user_id: USER_A, title: "Read" },
        { id: HABIT_B, user_id: USER_B, title: "Other" },
      ],
      habit_completions: [],
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
  return createHabitTools({
    supabase: client,
    timeZone: "Europe/Moscow",
    now: () => new Date("2026-09-25T22:00:00.000Z"),
  });
}

const ctxA = { from: { id: 101 } };

test("complete_habit creates today's local-date completion for the linked owner", async () => {
  const client = makeClient();
  const result = await toolsFor(client).complete_habit(ctxA, { habit_id: HABIT_A });

  assert.equal(result.completed, true);
  assert.equal(result.already_completed, false);
  assert.equal(result.completion.completed_date, "2026-09-26");
  assert.equal(result.completion.user_id, undefined);
  assert.equal(client.seed.habit_completions[0].user_id, USER_A);
  assert.ok(client.calls.some((call) => call.table === "habit_completions" && call.operation === "insert"));
});

test("complete_habit is idempotent across existing records and concurrent duplicate inserts", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  const [first, second] = await Promise.all([
    tools.complete_habit(ctxA, { habit_id: HABIT_A }),
    tools.complete_habit(ctxA, { habit_id: HABIT_A }),
  ]);

  assert.equal(client.seed.habit_completions.length, 1);
  assert.equal([first, second].filter((result) => !result.already_completed).length, 1);
  assert.equal([first, second].every((result) => result.completed), true);
});

test("a Telegram user cannot complete another user's habit", async () => {
  const client = makeClient();
  await assert.rejects(
    toolsFor(client).complete_habit(ctxA, { habit_id: HABIT_B }),
    { code: "HABIT_NOT_FOUND" }
  );
  assert.equal(client.seed.habit_completions.length, 0);
  assert.ok(!client.calls.some((call) => call.table === "habit_completions" && call.operation === "insert"));
});

test("undo_habit_completion only deletes the linked user's completion and is idempotent", async () => {
  const client = makeClient();
  client.seed.habit_completions.push(
    { id: "44444444-4444-4444-8444-444444444444", habit_id: HABIT_A, user_id: USER_A, completed_date: "2026-09-26" },
    { id: "55555555-5555-4555-8555-555555555555", habit_id: HABIT_B, user_id: USER_B, completed_date: "2026-09-26" }
  );
  const tools = toolsFor(client);
  const result = await tools.undo_habit_completion(ctxA, { habit_id: HABIT_A });
  const repeat = await tools.undo_habit_completion(ctxA, { habit_id: HABIT_A });

  assert.equal(result.completed, false);
  assert.equal(result.already_undone, false);
  assert.equal(repeat.already_undone, true);
  assert.deepEqual(client.seed.habit_completions.map((row) => row.habit_id), [HABIT_B]);
  const deletion = client.calls.find((call) => call.operation === "delete");
  assert.ok(deletion.filters.some(([op, field, value]) => op === "eq" && field === "user_id" && value === USER_A));
  assert.ok(deletion.filters.some(([op, field, value]) => op === "eq" && field === "habit_id" && value === HABIT_A));
});

test("habit tools validate ids and dates and reject unlinked Telegram accounts", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  await assert.rejects(tools.complete_habit(ctxA, { habit_id: "bad-id" }), /valid UUID/);
  await assert.rejects(tools.complete_habit(ctxA, { habit_id: HABIT_A, date: "2026-02-30" }), /valid calendar date/);
  await assert.rejects(tools.complete_habit({ from: { id: 909 } }, { habit_id: HABIT_A }), { code: "TELEGRAM_NOT_LINKED" });
});
