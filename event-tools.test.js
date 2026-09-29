const test = require("node:test");
const assert = require("node:assert/strict");
const { createEventTools } = require("./event-tools");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT_A = "11111111-1111-4111-8111-111111111111";
const EVENT_B = "22222222-2222-4222-8222-222222222222";

function matches(row, filters) {
  return filters.every(([operator, column, value]) => {
    const actual = row[column];
    if (operator === "eq") return actual === value;
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

  project(row) {
    if (!this.selected || this.selected === "*") return { ...row };
    return Object.fromEntries(this.selected.split(",").map((field) => [field.trim(), row[field.trim()]]));
  }

  execute() {
    this.client.calls.push({ table: this.table, operation: this.operation, filters: [...this.filters], payload: this.payload });
    const rows = this.client.seed[this.table] || (this.client.seed[this.table] = []);
    if (this.operation === "insert") {
      const row = { id: this.client.nextId(), created_at: this.client.createdAt, ...this.payload };
      rows.push(row);
      return { data: [this.project(row)], error: null };
    }
    const found = rows.filter((row) => matches(row, this.filters));
    if (this.operation === "update") {
      found.forEach((row) => Object.assign(row, this.payload));
      return { data: found.map((row) => this.project(row)), error: null };
    }
    if (this.operation === "delete") {
      this.client.seed[this.table] = rows.filter((row) => !matches(row, this.filters));
      return { data: found.map((row) => this.project(row)), error: null };
    }
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
      events: [
        { id: EVENT_A, user_id: USER_A, title: "Own event", start_at: "2026-09-25T10:00:00.000Z", end_at: "2026-09-25T11:00:00.000Z", color: "#3b82f6", recurrence: "none", recurrence_end_date: null, created_at: "2026-09-20T00:00:00.000Z" },
        { id: EVENT_B, user_id: USER_B, title: "Other event", start_at: "2026-09-25T12:00:00.000Z", end_at: "2026-09-25T13:00:00.000Z", color: "#10b981", recurrence: "none", recurrence_end_date: null, created_at: "2026-09-20T00:00:00.000Z" },
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
  return createEventTools({ supabase: client, timeZone: "UTC" });
}

const ctxA = { from: { id: 101 } };

test("create_event persists required times and validated defaults under the linked owner", async () => {
  const client = makeClient();
  const result = await toolsFor(client).create_event(ctxA, {
    title: "  Training  ",
    start_at: "2026-09-26T18:00:00+03:00",
    end_at: "2026-09-26T19:00:00+03:00",
  });

  assert.equal(result.created, true);
  assert.equal(result.event.title, "Training");
  assert.equal(result.event.start_at, "2026-09-26T15:00:00.000Z");
  assert.equal(result.event.user_id, undefined);
  const inserted = client.seed.events.at(-1);
  assert.equal(inserted.user_id, USER_A);
  assert.equal(inserted.color, "#3b82f6");
  assert.equal(inserted.recurrence, "none");
  assert.equal(inserted.recurrence_end_date, null);
});

test("create_event requires explicit valid interval and recurrence end date", async () => {
  const tools = toolsFor(makeClient());
  await assert.rejects(tools.create_event(ctxA, { title: "No end", start_at: "2026-09-25T10:00:00Z" }), /end_at/);
  await assert.rejects(tools.create_event(ctxA, { title: "Backwards", start_at: "2026-09-25T11:00:00Z", end_at: "2026-09-25T10:00:00Z" }), /later than/);
  await assert.rejects(tools.create_event(ctxA, { title: "No zone", start_at: "2026-09-25T10:00:00", end_at: "2026-09-25T11:00:00" }), /explicit timezone/);
  await assert.rejects(tools.create_event(ctxA, { title: "Recurring", start_at: "2026-09-25T10:00:00Z", end_at: "2026-09-25T11:00:00Z", recurrence: "weekly" }), /recurrence_end_date/);
  await assert.rejects(tools.create_event(ctxA, { title: "Owner", start_at: "2026-09-25T10:00:00Z", end_at: "2026-09-25T11:00:00Z", user_id: USER_B }), /Unsupported event field/);
});

test("create_event follows Planner's same-local-day rule", async () => {
  const tools = createEventTools({ supabase: makeClient(), timeZone: "Europe/Moscow" });
  await assert.rejects(tools.create_event(ctxA, {
    title: "Over midnight",
    start_at: "2026-09-25T20:30:00Z",
    end_at: "2026-09-25T21:30:00Z",
  }), /same local date/);
});

test("update_event scopes by id and owner and validates the combined interval", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  const result = await tools.update_event(ctxA, {
    event_id: EVENT_A,
    start_at: "2026-09-25T10:30:00Z",
    title: "Updated",
  });

  assert.equal(result.updated, true);
  assert.equal(client.seed.events[0].title, "Updated");
  assert.equal(client.seed.events[0].start_at, "2026-09-25T10:30:00.000Z");
  const call = client.calls.find((item) => item.operation === "update");
  assert.ok(call.filters.some(([op, key, value]) => op === "eq" && key === "id" && value === EVENT_A));
  assert.ok(call.filters.some(([op, key, value]) => op === "eq" && key === "user_id" && value === USER_A));

  await assert.rejects(tools.update_event(ctxA, { event_id: EVENT_B, title: "Hijack" }), { code: "EVENT_NOT_FOUND" });
  assert.equal(client.seed.events[1].title, "Other event");
  await assert.rejects(tools.update_event(ctxA, { event_id: EVENT_A, end_at: "2026-09-25T10:00:00Z" }), /later than/);
});

test("recurring event updates require valid recurrence end dates; none clears the end date", async () => {
  const client = makeClient();
  const tools = toolsFor(client);

  await assert.rejects(tools.update_event(ctxA, { event_id: EVENT_A, recurrence: "daily" }), /recurrence_end_date/);
  await tools.update_event(ctxA, {
    event_id: EVENT_A,
    recurrence: "weekly",
    recurrence_end_date: "2026-10-25",
  });
  assert.equal(client.seed.events[0].recurrence, "weekly");
  await tools.update_event(ctxA, { event_id: EVENT_A, recurrence: "none" });
  assert.equal(client.seed.events[0].recurrence_end_date, null);
});

test("delete_event cannot delete another linked user's event", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  await assert.rejects(tools.delete_event(ctxA, { event_id: EVENT_B }), { code: "EVENT_NOT_FOUND" });
  assert.ok(client.seed.events.some((event) => event.id === EVENT_B));

  const result = await tools.delete_event(ctxA, { event_id: EVENT_A });
  assert.equal(result.deleted, true);
  assert.equal(result.event.title, "Own event");
  assert.deepEqual(client.seed.events.map((event) => event.id), [EVENT_B]);
});
