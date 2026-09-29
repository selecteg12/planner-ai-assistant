const test = require("node:test");
const assert = require("node:assert/strict");
const { createIdeaTools } = require("./idea-tools");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IDEA_A = "11111111-1111-4111-8111-111111111111";
const IDEA_A_ARCHIVED = "22222222-2222-4222-8222-222222222222";
const IDEA_B = "33333333-3333-4333-8333-333333333333";

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
  order(column, options = {}) { this.ordering = [column, options]; return this; }

  project(row) {
    if (!this.selected || this.selected === "*") return { ...row };
    return Object.fromEntries(this.selected.split(",").map((field) => [field.trim(), row[field.trim()]]));
  }

  execute() {
    this.client.calls.push({ table: this.table, operation: this.operation, filters: [...this.filters], payload: this.payload });
    const rows = this.client.seed[this.table] || (this.client.seed[this.table] = []);
    if (this.operation === "insert") {
      const row = { id: this.client.nextId(), created_at: this.client.createdAt, archived: false, ...this.payload };
      rows.push(row);
      return { data: [this.project(row)], error: null };
    }
    const found = rows.filter((row) => matches(row, this.filters));
    if (this.operation === "update") {
      found.forEach((row) => Object.assign(row, this.payload));
    }
    if (this.operation === "delete") {
      this.client.seed[this.table] = rows.filter((row) => !matches(row, this.filters));
    }
    let data = found;
    if (this.operation === "select" && this.ordering) {
      const [column, options] = this.ordering;
      data = [...data].sort((a, b) => options.ascending === false
        ? String(b[column]).localeCompare(String(a[column]))
        : String(a[column]).localeCompare(String(b[column])));
    }
    return { data: data.map((row) => this.project(row)), error: null };
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
      ideas: [
        { id: IDEA_A, user_id: USER_A, title: "Budget app", category: "apps", archived: false, created_at: "2026-09-25T12:00:00Z" },
        { id: IDEA_A_ARCHIVED, user_id: USER_A, title: "Old idea", category: null, archived: true, created_at: "2026-09-24T12:00:00Z" },
        { id: IDEA_B, user_id: USER_B, title: "Other idea", category: null, archived: false, created_at: "2026-09-26T12:00:00Z" },
      ],
    },
    calls: [],
    createdAt: "2026-09-27T12:00:00Z",
    nextId() {
      sequence += 1;
      return `44444444-4444-4444-8444-${String(sequence).padStart(12, "0")}`;
    },
    from(table) { return new FakeQuery(this, table); },
  };
}

function toolsFor(client) { return createIdeaTools({ supabase: client }); }
const ctxA = { from: { id: 101 } };

test("create_idea uses the verified owner and normalizes title/category", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  await assert.rejects(tools.create_idea(ctxA, { title: "Budget planner", user_id: USER_B }), /Unsupported idea field/);
  const result = await tools.create_idea(ctxA, {
    title: "  Budget planner  ",
    category: "  apps  ",
  });

  assert.equal(result.created, true);
  assert.equal(result.idea.title, "Budget planner");
  assert.equal(result.idea.user_id, undefined);
  assert.equal(client.seed.ideas.at(-1).user_id, USER_A);
  assert.equal(client.seed.ideas.at(-1).category, "apps");
  assert.equal(client.seed.ideas.at(-1).archived, false);
});

test("get_ideas returns only the owner's active ideas by default", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  const active = await tools.get_ideas(ctxA);
  const all = await tools.get_ideas(ctxA, { include_archived: true });

  assert.deepEqual(active.ideas.map((idea) => idea.id), [IDEA_A]);
  assert.deepEqual(all.ideas.map((idea) => idea.id), [IDEA_A, IDEA_A_ARCHIVED]);
  for (const call of client.calls.filter((item) => item.table === "ideas")) {
    assert.ok(call.filters.some(([op, key, value]) => op === "eq" && key === "user_id" && value === USER_A));
  }
});

test("update_idea cannot access or mutate another user's idea", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  const result = await tools.update_idea(ctxA, { idea_id: IDEA_A, title: "Updated" });

  assert.equal(result.updated, true);
  assert.equal(client.seed.ideas[0].title, "Updated");
  await assert.rejects(tools.update_idea(ctxA, { idea_id: IDEA_B, title: "Hijack" }), { code: "IDEA_NOT_FOUND" });
  assert.equal(client.seed.ideas[2].title, "Other idea");
});

test("archive_idea archives and restores only the linked user's idea", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  const archived = await tools.archive_idea(ctxA, { idea_id: IDEA_A });
  const restored = await tools.archive_idea(ctxA, { idea_id: IDEA_A, archived: false });

  assert.equal(archived.archived, true);
  assert.equal(client.seed.ideas[0].archived, false);
  assert.equal(restored.archived, false);
  await assert.rejects(tools.archive_idea(ctxA, { idea_id: IDEA_B }), { code: "IDEA_NOT_FOUND" });
  assert.equal(client.seed.ideas[2].archived, false);
});

test("delete_idea is owner-scoped; validation rejects empty titles and invalid filters", async () => {
  const client = makeClient();
  const tools = toolsFor(client);
  await assert.rejects(tools.create_idea(ctxA, { title: "   " }), /non-empty/);
  await assert.rejects(tools.get_ideas(ctxA, { include_archived: "yes" }), /must be a boolean/);
  await assert.rejects(tools.delete_idea(ctxA, { idea_id: IDEA_B }), { code: "IDEA_NOT_FOUND" });
  assert.ok(client.seed.ideas.some((idea) => idea.id === IDEA_B));

  const deleted = await tools.delete_idea(ctxA, { idea_id: IDEA_A });
  assert.equal(deleted.deleted, true);
  assert.deepEqual(client.seed.ideas.map((idea) => idea.id), [IDEA_A_ARCHIVED, IDEA_B]);
});
