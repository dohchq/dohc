const AREAS = ["platform", "apps", "sync", "mobile"];
const STATUSES = ["new", "triaged", "planned", "in_progress", "done"];
const MOVES = {
  planned: ["in_progress"],
  in_progress: ["done", "planned"],
  done: ["in_progress"],
};
const MAX_MILESTONES = 100;
const MAX_IMPORT = 1000;
const MAX_PAGE = 25;
const PREVIEW = 280;
const MAX_PARAMS = 128;
const ITEM_COLUMNS = [
  "id",
  "title",
  "detail",
  "area",
  "status",
  "priority",
  "milestone_id",
  "estimate_days",
  "triage_note",
  "requested_by",
  "triaged_by",
  "updated_by",
  "created_at",
  "updated_at",
  "version",
];
const selectItems = (
  detail,
) => `SELECT i.id, i.title, ${detail} AS detail, i.area, i.status, i.priority,
  i.milestone_id AS milestoneId, m.name AS milestoneName, i.estimate_days AS estimateDays,
  i.triage_note AS triageNote, i.requested_by AS requestedBy, i.triaged_by AS triagedBy,
  i.updated_by AS updatedBy, i.created_at AS createdAt, i.updated_at AS updatedAt, i.version,
  i.archived_at AS archivedAt, coalesce(i.priority, 4) AS rank
  FROM items i LEFT JOIN milestones m ON m.id = i.milestone_id`;
const SELECT_ITEM = selectItems("i.detail");
const SELECT_PAGE = selectItems(
  `CASE WHEN length(i.detail) > ${PREVIEW} THEN substr(i.detail, 1, ${PREVIEW - 1}) || '…' ELSE i.detail END`,
);

function requireOwner(ctx) {
  if (ctx.caller.kind !== "owner") ctx.refuse("forbidden", "Only the roadmap owner can do this.");
}

function requireTeam(ctx) {
  if (ctx.caller.kind !== "owner" && !(ctx.caller.kind === "named" && ctx.caller.helper))
    ctx.refuse("forbidden", "Only the roadmap team can do this.");
}

function who(ctx) {
  return ctx.caller.userId ?? ctx.caller.kind;
}

function text(ctx, value, field, max, optional) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result && optional) return "";
  if (!result || result.length > max)
    ctx.refuse("invalid_input", `Enter ${field} of 1 to ${max} characters.`);
  return result;
}

function whole(ctx, value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max)
    ctx.refuse("invalid_input", `${field} must be a whole number from ${min} to ${max}.`);
  return value;
}

function oneOf(ctx, value, options, field) {
  if (!options.includes(value)) ctx.refuse("invalid_input", `Choose a ${field}.`);
  return value;
}

function date(ctx, value) {
  const parsed = typeof value === "string" ? Date.parse(`${value}T00:00:00Z`) : NaN;
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().startsWith(value);
  if (!valid) ctx.refuse("invalid_input", "Enter a due date as YYYY-MM-DD.");
  return value;
}

function present(row) {
  const { rank: _rank, ...item } = row;
  return item;
}

function loadItem(ctx, input) {
  const id = typeof input?.id === "string" ? input.id : "";
  const row = ctx.db.query(`${SELECT_ITEM} WHERE i.id = ?`, [id])[0];
  if (!row) ctx.refuse("not_found", "This item no longer exists.");
  if (input.version !== row.version)
    ctx.refuse("conflict", "Someone changed this item. Reload it and try again.");
  return { item: row, archived: row.archivedAt !== null };
}

function liveItem(ctx, input) {
  const loaded = loadItem(ctx, input);
  if (loaded.archived) ctx.refuse("not_found", "This item was archived.");
  return loaded.item;
}

function update(ctx, id, assignments, values) {
  ctx.db.execute(
    `UPDATE items SET ${assignments}, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    [...values, who(ctx), ctx.nowMs, id],
  );
  return present(ctx.db.query(`${SELECT_ITEM} WHERE i.id = ?`, [id])[0]);
}

function milestoneCount(ctx, adding) {
  const count = ctx.db.query("SELECT count(*) AS n FROM milestones")[0].n + adding;
  if (count > MAX_MILESTONES)
    ctx.refuse(
      "limit",
      `A roadmap holds up to ${MAX_MILESTONES} milestones. This would make ${count}.`,
    );
}

function milestoneId(ctx, value) {
  const id = typeof value === "string" ? value : "";
  if (!ctx.db.query("SELECT 1 AS found FROM milestones WHERE id = ?", [id]).length)
    ctx.refuse("invalid_input", "Choose a milestone.");
  return id;
}

function insertItems(ctx, rows) {
  const perStatement = Math.floor(MAX_PARAMS / ITEM_COLUMNS.length);
  const marks = `(${ITEM_COLUMNS.map(() => "?").join(", ")})`;
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    ctx.db.execute(
      `INSERT INTO items (${ITEM_COLUMNS.join(", ")}) VALUES ${chunk.map(() => marks).join(", ")}`,
      chunk.flatMap((row) => ITEM_COLUMNS.map((column) => row[column] ?? null)),
    );
  }
}

function importedItem(ctx, raw, index, milestones) {
  const at = `Item ${index + 1}: `;
  const fail = (message) => ctx.refuse("invalid_input", at + message);
  if (!raw || typeof raw !== "object") fail("send an object.");
  const status = raw.status ?? "new";
  if (!STATUSES.includes(status)) fail("choose a status.");
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title || title.length > 120) fail("enter a title of 1 to 120 characters.");
  const detail = typeof raw.detail === "string" ? raw.detail.trim() : "";
  if (detail.length > 2000) fail("keep the detail under 2000 characters.");
  if (!AREAS.includes(raw.area)) fail("choose an area.");
  const triaged = status !== "new";
  const planned = triaged && status !== "triaged";
  const estimate = triaged ? raw.estimateDays : null;
  if (triaged && !(Number.isInteger(estimate) && estimate >= 1 && estimate <= 60))
    fail("a triaged item needs an estimate of 1 to 60 days.");
  const priority = planned ? raw.priority : null;
  if (planned && !(Number.isInteger(priority) && priority >= 0 && priority <= 3))
    fail("a planned item needs a priority from 0 to 3.");
  const milestone = planned ? milestones.get(raw.milestone) : null;
  if (planned && !milestone) fail("a planned item needs a milestone from this roadmap.");
  return {
    id: `${ctx.requestId}-${index}`,
    title,
    detail,
    area: raw.area,
    status,
    priority,
    milestone_id: milestone,
    estimate_days: estimate,
    requested_by: who(ctx),
    triaged_by: triaged ? who(ctx) : null,
    updated_by: who(ctx),
    created_at: ctx.nowMs,
    updated_at: ctx.nowMs,
    version: 1,
  };
}

globalThis.operations = {
  listItems(ctx, input = {}) {
    requireTeam(ctx);
    const where = ["i.archived_at IS NULL"];
    const values = [];
    if (input.id !== undefined) {
      where.push("i.id = ?");
      values.push(typeof input.id === "string" ? input.id : "");
    }
    if (input.status !== undefined) {
      where.push("i.status = ?");
      values.push(oneOf(ctx, input.status, STATUSES, "status"));
    }
    if (input.area !== undefined) {
      where.push("i.area = ?");
      values.push(oneOf(ctx, input.area, AREAS, "area"));
    }
    if (input.milestoneId !== undefined) {
      where.push("i.milestone_id = ?");
      values.push(typeof input.milestoneId === "string" ? input.milestoneId : "");
    }
    const limit =
      input.limit === undefined ? MAX_PAGE : whole(ctx, input.limit, 1, MAX_PAGE, "Page size");
    const total = ctx.db.query(
      `SELECT count(*) AS n FROM items i WHERE ${where.join(" AND ")}`,
      values,
    )[0].n;
    const after = input.after;
    if (after !== undefined) {
      const valid =
        Array.isArray(after) &&
        after.length === 3 &&
        Number.isInteger(after[0]) &&
        Number.isInteger(after[1]) &&
        typeof after[2] === "string";
      if (!valid)
        ctx.refuse("invalid_input", "This page link is not valid. Start from the first page.");
      where.push("(coalesce(i.priority, 4), i.created_at, i.id) > (?, ?, ?)");
      values.push(after[0], after[1], after[2]);
    }
    const rows = ctx.db.query(
      `${input.id === undefined ? SELECT_PAGE : SELECT_ITEM} WHERE ${where.join(" AND ")} ORDER BY coalesce(i.priority, 4), i.created_at, i.id LIMIT ?`,
      [...values, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(present),
      total,
      next: rows.length > limit ? [last.rank, last.createdAt, last.id] : null,
    };
  },

  rollup(ctx) {
    const statuses = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    let p0Open = 0;
    for (const row of ctx.db.query(
      `SELECT status, count(*) AS n, sum(priority = 0) AS p0 FROM items
       WHERE archived_at IS NULL GROUP BY status`,
    )) {
      statuses[row.status] = row.n;
      if (row.status !== "done") p0Open += row.p0 ?? 0;
    }
    const milestones = ctx.db.query(
      `SELECT m.id, m.name, m.due_on AS dueOn, count(i.id) AS total,
        coalesce(sum(i.status = 'done'), 0) AS done,
        coalesce(sum(i.status = 'in_progress'), 0) AS inProgress,
        coalesce(sum(i.status <> 'done' AND i.priority = 0), 0) AS p0Open,
        coalesce(sum(CASE WHEN i.status <> 'done' THEN i.estimate_days END), 0) AS openDays
       FROM milestones m LEFT JOIN items i ON i.milestone_id = m.id AND i.archived_at IS NULL
       GROUP BY m.id ORDER BY m.due_on, m.name`,
    );
    const areas = ctx.db.query(
      `SELECT area, sum(status <> 'done') AS open, sum(status = 'done') AS done FROM items
       WHERE archived_at IS NULL GROUP BY area ORDER BY area`,
    );
    const total = Object.values(statuses).reduce((sum, n) => sum + n, 0);
    return { total, open: total - statuses.done, p0Open, statuses, milestones, areas };
  },

  createItem(ctx, input = {}) {
    requireOwner(ctx);
    insertItems(ctx, [
      {
        id: ctx.requestId,
        title: text(ctx, input.title, "a title", 120),
        detail: text(ctx, input.detail, "detail", 2000, true),
        area: oneOf(ctx, input.area, AREAS, "area"),
        status: "new",
        requested_by: who(ctx),
        updated_by: who(ctx),
        created_at: ctx.nowMs,
        updated_at: ctx.nowMs,
        version: 1,
      },
    ]);
    return { id: ctx.requestId };
  },

  importItems(ctx, input = {}) {
    requireOwner(ctx);
    const incoming = input.milestones ?? [];
    const items = input.items;
    if (!Array.isArray(incoming)) ctx.refuse("invalid_input", "Send milestones as a list.");
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_IMPORT)
      ctx.refuse(
        "invalid_input",
        `Send 1 to ${MAX_IMPORT} items at a time. This sent ${items?.length ?? 0}.`,
      );
    const milestones = new Map(
      ctx.db.query("SELECT id, name FROM milestones").map((row) => [row.name, row.id]),
    );
    const added = [];
    for (const [index, raw] of incoming.entries()) {
      const name = text(ctx, raw?.name, `milestone ${index + 1}'s name`, 60);
      const dueOn = date(ctx, raw?.dueOn);
      if (milestones.has(name)) continue;
      const id = `${ctx.requestId}-m${index}`;
      milestones.set(name, id);
      added.push([id, name, dueOn]);
    }
    milestoneCount(ctx, added.length);
    for (const [id, name, dueOn] of added)
      ctx.db.execute("INSERT INTO milestones (id, name, due_on, created_at) VALUES (?, ?, ?, ?)", [
        id,
        name,
        dueOn,
        ctx.nowMs,
      ]);
    insertItems(
      ctx,
      items.map((raw, index) => importedItem(ctx, raw, index, milestones)),
    );
    return { milestones: added.length, items: items.length };
  },

  createMilestone(ctx, input = {}) {
    requireOwner(ctx);
    const name = text(ctx, input.name, "a name", 60);
    const dueOn = date(ctx, input.dueOn);
    if (ctx.db.query("SELECT 1 AS found FROM milestones WHERE name = ?", [name]).length)
      ctx.refuse("duplicate", `There is already a milestone named ${name}.`);
    milestoneCount(ctx, 1);
    ctx.db.execute("INSERT INTO milestones (id, name, due_on, created_at) VALUES (?, ?, ?, ?)", [
      ctx.requestId,
      name,
      dueOn,
      ctx.nowMs,
    ]);
    return { id: ctx.requestId };
  },

  planItem(ctx, input = {}) {
    requireOwner(ctx);
    const item = liveItem(ctx, input);
    if (item.status === "new")
      ctx.refuse("invalid_state", "Engineering triages an item before it is planned.");
    if (item.status === "done") ctx.refuse("invalid_state", "This item is done.");
    const priority = whole(ctx, input.priority, 0, 3, "Priority");
    const milestone = milestoneId(ctx, input.milestoneId);
    return {
      item: update(
        ctx,
        item.id,
        "priority = ?, milestone_id = ?, status = CASE status WHEN 'triaged' THEN 'planned' ELSE status END",
        [priority, milestone],
      ),
    };
  },

  archiveItem(ctx, input = {}) {
    requireOwner(ctx);
    const item = liveItem(ctx, input);
    const archived = update(ctx, item.id, "archived_at = ?", [ctx.nowMs]);
    return { item: archived, undo: { id: item.id, version: archived.version } };
  },

  restoreItem(ctx, input = {}) {
    requireOwner(ctx);
    const { item, archived } = loadItem(ctx, input);
    if (!archived) ctx.refuse("invalid_state", "This item is not archived.");
    return { item: update(ctx, item.id, "archived_at = NULL", []) };
  },

  triageItem(ctx, input = {}) {
    requireTeam(ctx);
    const item = liveItem(ctx, input);
    if (item.status !== "new") ctx.refuse("invalid_state", "This item is already triaged.");
    const estimate = whole(ctx, input.estimateDays, 1, 60, "Estimate in days");
    const note = text(ctx, input.note, "a note", 500, true);
    return {
      item: update(
        ctx,
        item.id,
        "status = 'triaged', estimate_days = ?, triage_note = ?, triaged_by = ?",
        [estimate, note || null, who(ctx)],
      ),
    };
  },

  updateStatus(ctx, input = {}) {
    requireTeam(ctx);
    const item = liveItem(ctx, input);
    const status = oneOf(ctx, input.status, STATUSES, "status");
    if (!(MOVES[item.status] ?? []).includes(status))
      ctx.refuse(
        "invalid_state",
        item.status === "new" || item.status === "triaged"
          ? "Plan this item before work starts."
          : `An item that is ${item.status.replace("_", " ")} cannot move to ${status.replace("_", " ")}.`,
      );
    return { item: update(ctx, item.id, "status = ?", [status]) };
  },
};
