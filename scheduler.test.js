const test = require("node:test");
const assert = require("node:assert/strict");
const { processDueReminders } = require("./scheduler");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REMINDER_A = "11111111-1111-4111-8111-111111111111";

function matches(row, filters) {
  return filters.every(([operator, column, value]) => {
    const actual = row[column];
    if (operator === "eq") return actual === value;
    if (operator === "lte") return actual <= value;
    if (operator === "in") return value.includes(actual);
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
  update(payload) { this.operation = "update"; this.payload = payload; return this; }
  eq(column, value) { this.filters.push(["eq", column, value]); return this; }
  lte(column, value) { this.filters.push(["lte", column, value]); return this; }
  in(column, value) { this.filters.push(["in", column, value]); return this; }
  order() { return this; }
  limit() { return this; }

  project(row) {
    if (!this.selected || this.selected === "*") return { ...row };
    return Object.fromEntries(this.selected.split(",").map((field) => [field.trim(), row[field.trim()]]));
  }

  execute() {
    const rows = this.client.seed[this.table] || [];
    const found = rows.filter((row) => matches(row, this.filters));
    if (this.operation === "update") found.forEach((row) => Object.assign(row, this.payload));
    return { data: found.map((row) => this.project(row)), error: null };
  }

  async maybeSingle() {
    const result = this.execute();
    return { data: result.data[0] || null, error: null };
  }

  then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
}

function makeClient() {
  return {
    seed: {
      reminders: [
        { id: REMINDER_A, user_id: USER_A, text: "Call the dentist", remind_at: "2026-09-25T11:59:00.000Z", status: "pending", sent_at: null, claimed_at: null },
        { id: "22222222-2222-4222-8222-222222222222", user_id: USER_B, text: "Other user's reminder", remind_at: "2026-09-25T11:58:00.000Z", status: "pending", sent_at: null, claimed_at: null },
      ],
      telegram_users: [
        { supabase_user_id: USER_A, telegram_id: 101 },
        { supabase_user_id: USER_B, telegram_id: 202 },
      ],
    },
    from(table) { return new FakeQuery(this, table); },
  };
}

const fixedNow = () => new Date("2026-09-25T12:00:00.000Z");

test("scheduler sends a due reminder once and records sent state", async () => {
  const supabase = makeClient();
  const sentTo = [];
  const result = await processDueReminders({
    supabase,
    telegram: { async sendMessage(chatId, text) { sentTo.push({ chatId, text }); } },
    now: fixedNow,
  });

  assert.equal(result.sent, 2);
  assert.deepEqual(sentTo, [
    { chatId: 101, text: "Call the dentist" },
    { chatId: 202, text: "Other user's reminder" },
  ]);
  assert.ok(supabase.seed.reminders.every((reminder) => reminder.status === "sent" && reminder.sent_at));

  const secondRun = await processDueReminders({
    supabase,
    telegram: { async sendMessage() { assert.fail("sent reminder must not be delivered twice"); } },
    now: fixedNow,
  });
  assert.equal(secondRun.due, 0);
});

test("concurrent scheduler cycles atomically claim a reminder so it is sent once", async () => {
  const supabase = makeClient();
  supabase.seed.reminders = [supabase.seed.reminders[0]];
  supabase.seed.telegram_users = [supabase.seed.telegram_users[0]];
  const deliveries = [];
  const telegram = { async sendMessage(chatId, text) { deliveries.push({ chatId, text }); } };

  const results = await Promise.all([
    processDueReminders({ supabase, telegram, now: fixedNow }),
    processDueReminders({ supabase, telegram, now: fixedNow }),
  ]);

  assert.equal(deliveries.length, 1);
  assert.equal(results.reduce((sum, result) => sum + result.sent, 0), 1);
});

test("ambiguous Telegram failures keep the claim so automatic polling will not duplicate", async () => {
  const supabase = makeClient();
  supabase.seed.reminders = [supabase.seed.reminders[0]];
  supabase.seed.telegram_users = [supabase.seed.telegram_users[0]];
  let attempts = 0;
  const logger = { warn() {}, error() {} };
  const result = await processDueReminders({
    supabase,
    telegram: { async sendMessage() { attempts += 1; throw new Error("network outcome unknown"); } },
    now: fixedNow,
    logger,
  });
  const next = await processDueReminders({
    supabase,
    telegram: { async sendMessage() { attempts += 1; } },
    now: fixedNow,
    logger,
  });

  assert.equal(result.failed, 1);
  assert.equal(supabase.seed.reminders[0].status, "processing");
  assert.equal(next.due, 0);
  assert.equal(attempts, 1);
});
