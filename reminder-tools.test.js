const test = require("node:test");
const assert = require("node:assert/strict");
const { createReminderTools } = require("./reminder-tools");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REMINDER_PENDING = "11111111-1111-4111-8111-111111111111";
const REMINDER_PROCESSING = "22222222-2222-4222-8222-222222222222";
const REMINDER_SENT = "33333333-3333-4333-8333-333333333333";
const REMINDER_OTHER = "44444444-4444-4444-8444-444444444444";

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
  update(payload) { this.operation = "update"; this.payload = payload; return this; }
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
      const row = {
        id: this.client.nextId(),
        status: "pending",
        sent_at: null,
        claimed_at: null,
        created_at: this.client.createdAt,
        ...this.payload,
      };
      rows.push(row);
      return { data: [this.project(row)], error: null };
    }
    const found = rows.filter((row) => matches(row, this.filters));
    if (this.operation === "update") found.forEach((row) => Object.assign(row, this.payload));
    if (this.operation === "delete") this.client.seed[this.table] = rows.filter((row) => !matches(row, this.filters));
    return { data: found.map((row) => this.project(row)), error: null };
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
      reminders: [
        { id: REMINDER_PENDING, user_id: USER_A, text: "Call", remind_at: "2026-09-26T12:00:00Z", sent_at: null, status: "pending", claimed_at: null, created_at: "2026-09-25T00:00:00Z" },
        { id: REMINDER_PROCESSING, user_id: USER_A, text: "Check mail", remind_at: "2026-09-26T13:00:00Z", sent_at: null, status: "processing", claimed_at: "2026-09-25T11:00:00Z", created_at: "2026-09-25T00:00:00Z" },
        { id: REMINDER_SENT, user_id: USER_A, text: "Already sent", remind_at: "2026-09-24T13:00:00Z", sent_at: "2026-09-24T13:00:01Z", status: "sent", claimed_at: null, created_at: "2026-09-23T00:00:00Z" },
        { id: REMINDER_OTHER, user_id: USER_B, text: "Other user's", remind_at: "2026-09-26T14:00:00Z", sent_at: null, status: "pending", claimed_at: null, created_at: "2026-09-25T00:00:00Z" },
      ],
    },
    calls: [],
    createdAt: "2026-09-25T12:00:00Z",
    nextId() {
      sequence += 1;
      return `55555555-5555-4555-8555-${String(sequence).padStart(12, "0")}`;
    },
    from(table) { return new FakeQuery(this, table); },
  };
}

function toolsFor(client) {
  return createReminderTools({ supabase: client, now: () => new Date("2026-09-25T12:00:00Z") });
}
const ctxA = { from: { id: 101 } };

test("create_reminder stores a future instant under the linked owner", async () => {
  const client = makeClient();
  const result = await toolsFor(client).create_reminder(ctxA, {
    text: "  Call tomorrow  ",
    remind_at: "2026-09-26T15:00:00+03:00",
  });

  assert.equal(result.created, true);
  assert.equal(result.reminder.text, "Call tomorrow");
  assert.equal(result.reminder.remind_at, "2026-09-26T12:00:00.000Z");
  assert.equal(result.reminder.user_id, undefined);
  assert.equal(client.seed.reminders.at(-1).user_id, USER_A);
  assert.equal(client.seed.reminders.at(-1).status, "pending");
});

test("create_reminder rejects missing timezone, past dates, blank text and supplied user id", async () => {
  const tools = toolsFor(makeClient());
  await assert.rejects(tools.create_reminder(ctxA, { text: "x", remind_at: "2026-09-26T15:00:00" }), /explicit timezone/);
  await assert.rejects(tools.create_reminder(ctxA, { text: "x", remind_at: "2026-09-25T11:00:00Z" }), /future/);
  await assert.rejects(tools.create_reminder(ctxA, { text: " ", remind_at: "2026-09-26T15:00:00Z" }), /non-empty/);
  await assert.rejects(tools.create_reminder(ctxA, { text: "x", remind_at: "2026-09-26T15:00:00Z", user_id: USER_B }), /Unsupported reminder field/);
});

test("cancel_reminder cancels pending and processing reminders with owner and state guards", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  const pending = await tools.cancel_reminder(ctxA, { reminder_id: REMINDER_PENDING });
  const processing = await tools.cancel_reminder(ctxA, { reminder_id: REMINDER_PROCESSING });

  assert.equal(pending.cancelled, true);
  assert.equal(client.seed.reminders[0].status, "cancelled");
  assert.equal(processing.cancelled, true);
  assert.equal(client.seed.reminders[1].status, "cancelled");
  assert.equal(client.seed.reminders[1].claimed_at, null);
  const updates = client.calls.filter((call) => call.operation === "update");
  for (const update of updates) {
    assert.ok(update.filters.some(([op, key, value]) => op === "eq" && key === "user_id" && value === USER_A));
    assert.ok(update.filters.some(([op, key]) => op === "eq" && key === "status"));
  }
});

test("cancellation cannot access another user's reminder or reverse sent status", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  await assert.rejects(tools.cancel_reminder(ctxA, { reminder_id: REMINDER_OTHER }), { code: "REMINDER_NOT_FOUND" });

  const sent = await tools.cancel_reminder(ctxA, { reminder_id: REMINDER_SENT });
  assert.equal(sent.cancelled, false);
  assert.equal(sent.already_sent, true);
  assert.equal(client.seed.reminders[3].status, "pending");
  assert.equal(client.seed.reminders[2].status, "sent");
});

test("repeated cancellation is idempotent and invalid identifiers are rejected", async () => {
  const tools = toolsFor(makeClient());
  const first = await tools.cancel_reminder(ctxA, { reminder_id: REMINDER_PENDING });
  const again = await tools.cancel_reminder(ctxA, { reminder_id: REMINDER_PENDING });

  assert.equal(first.already_cancelled, false);
  assert.equal(again.already_cancelled, true);
  await assert.rejects(tools.cancel_reminder(ctxA, { reminder_id: "invalid" }), /valid UUID/);
});
