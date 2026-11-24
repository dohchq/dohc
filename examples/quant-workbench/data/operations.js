const DAY = 86_400_000;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const GRANT = /^[a-zA-Z0-9_-]{1,128}$/;
const SERIES_COLUMNS = "id, slug, name, unit, domain, color";
const NOTE_COLUMNS = "id, title, date_start, date_end, series_ids_json, created_at_ms, grant_id";

const BUCKETS = {
  day: ["substr(observed_at, 1, 10)", "bucket"],
  week: ["date(observed_at, '-6 days', 'weekday 1')", "date(bucket, '+6 days')"],
  month: ["date(observed_at, 'start of month')", "date(bucket, '+1 month', '-1 day')"],
  year: ["date(observed_at, 'start of year')", "date(bucket, '+1 year', '-1 day')"],
};

const SOURCE = `
  FROM observations AS o
  JOIN import_batches AS b ON b.id = o.import_batch_id AND b.imported_at_ms IS NOT NULL
`;

function seedDemo(ctx) {
  const expected = 365 * 8 * 8;
  if (ctx.db.query("SELECT id FROM import_batches LIMIT 1").length) return { inserted: 0 };
  insertRows(
    ctx,
    "INSERT INTO series (id, slug, name, unit, domain, color)",
    [
      ["sample-sleep-hours", "Sleep duration", "h", "Sample health", 1],
      ["sample-resting-hr", "Resting heart rate", "bpm", "Sample health", 2],
      ["sample-steps", "Step count", "steps", "Sample health", 3],
      ["sample-hrv", "Heart rate variability", "ms", "Sample health", 4],
      ["sample-training-load", "Training load", "AU", "Sample health", 5],
      ["sample-close", "Portfolio value", "USD", "Sample portfolio", 6],
      ["sample-volume", "Trading volume", "shares", "Sample portfolio", 2],
      ["sample-daily-return", "Daily return", "%", "Sample portfolio", 3],
    ].map((item) => [item[0], ...item]),
  );
  ctx.db.execute(
    `INSERT INTO import_batches (id, filename, sha256, row_count, received_rows, imported_at_ms)
    VALUES (1, 'SignalBook sample', ?, ?, ?, ?)`,
    [
      "4d95b13b1aff44b5e42c4fc56b5829a0711f653c3fe309f437937c127747ca9c",
      expected,
      expected,
      ctx.nowMs,
    ],
  );
  const { changes } = ctx.db.execute(`WITH RECURSIVE
      days(day) AS (VALUES (0) UNION ALL SELECT day + 1 FROM days WHERE day < 364),
      slots(slot) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7)),
      samples AS (
        SELECT day, slot,
          date('2025-01-01', printf('+%d days', day)) || printf('T%02d:00:00.000Z', slot * 3) AS stamp,
          sin(day * 74.97 + slot * 6.6) AS noise,
          day % 89 = 0 AND slot = 6 AS pulse,
          0.58 * sin(day / 11.0) + 0.42 * sin(day * 1.3) AS sleep,
          0.58 * sin((day - 2) / 11.0) + 0.42 * sin((day - 2) * 1.3) AS prior_sleep
        FROM days CROSS JOIN slots
      )
    INSERT INTO observations (id, series_id, observed_at, value, tags_json, import_batch_id)
    SELECT row_number() OVER (ORDER BY day, slot, series.id), series.id, stamp,
      round(CASE series.id
        WHEN 'sample-sleep-hours' THEN 7.2 + sleep + 0.14 * noise - pulse * 2
        WHEN 'sample-resting-hr' THEN 62 - 4 * prior_sleep + 1.9 * cos(day / 6.0) + 0.6 * noise + pulse * 12
        WHEN 'sample-steps' THEN 7800 + 1700 * sin(day / 8.0) + 1800 * noise + pulse * 9000
        WHEN 'sample-hrv' THEN 54 + 7 * sleep + 6 * sin(day / 21.0) + 3 * noise
        WHEN 'sample-training-load' THEN 58 + 26 * sin(day / 6.0) + 15 * noise + pulse * 65
        WHEN 'sample-close' THEN 24000 + 18 * day + 870 * sin(day / 14.0) + 180 * noise
        WHEN 'sample-volume' THEN 340 + 110 * sin(day / 13.0) + 75 * noise + pulse * 500
        WHEN 'sample-daily-return' THEN 0.12 + 0.9 * sin(day / 14.0 + 1.57) + 0.25 * noise
      END, 4), '{"source":"demo"}', 1
    FROM samples CROSS JOIN series`);
  if (changes !== expected)
    ctx.refuse("invalid_sample", "Could not create the sample observations.");
  return { inserted: changes };
}

function dateIsValid(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const ms = Date.parse(date);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

function filters(ctx, input) {
  const { start, end, ids } = input ?? {};
  if (!dateIsValid(start) || !dateIsValid(end) || start > end)
    ctx.refuse("invalid_range", "Choose a valid start and end date.");
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 2 ||
    ids.some((id) => typeof id !== "string" || !SLUG.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    ctx.refuse("invalid_series", "Choose one or two different series.");
  }
  return { start, end, ids };
}

function resolution(start, end, requested, max) {
  const days = (Date.parse(end) - Date.parse(start)) / DAY + 1;
  const choices = ["day", "week", "month", "year"];
  const minimum = days <= max ? 0 : days <= (max - 1) * 7 ? 1 : days <= (max - 1) * 28 ? 2 : 3;
  return choices[Math.max(choices.indexOf(requested), minimum)];
}

function rollup(ctx, id, start, end, grain) {
  const [bucket, bucketEnd] = BUCKETS[grain];
  return ctx.db.query(
    `WITH RECURSIVE
      bounds(start, finish) AS (VALUES (?, ?)),
      source AS MATERIALIZED (
        SELECT o.id, o.observed_at, o.value ${SOURCE}, bounds
        WHERE o.series_id = ?
          AND o.observed_at >= date(start, '-29 days') || 'T00:00:00.000Z'
          AND o.observed_at <= finish || 'T23:59:59.999Z'
      ),
      daily AS (
        SELECT substr(observed_at, 1, 10) AS day, avg(value) AS mean
        FROM source GROUP BY day
      ),
      calendar(day) AS (
        SELECT date(start, '-29 days') FROM bounds
        UNION ALL SELECT date(day, '+1 day') FROM calendar, bounds WHERE day < finish
      ),
      rolling AS (
        SELECT day,
          avg(mean) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS ma7,
          avg(mean) OVER (ORDER BY day ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS ma30
        FROM calendar LEFT JOIN daily USING (day)
      ),
      ordered AS (
        SELECT ${bucket} AS bucket, value,
          row_number() OVER (PARTITION BY ${bucket} ORDER BY observed_at, id) AS opening,
          row_number() OVER (PARTITION BY ${bucket} ORDER BY observed_at DESC, id DESC) AS closing
        FROM source, bounds WHERE observed_at >= start || 'T00:00:00.000Z'
      ),
      bars AS (
        SELECT bucket, count(*) AS count, avg(value) AS mean, sum(value) AS total,
          min(value) AS low, max(value) AS high,
          max(CASE opening WHEN 1 THEN value END) AS open,
          max(CASE closing WHEN 1 THEN value END) AS close
        FROM ordered GROUP BY bucket
      )
      SELECT bars.*, ma7, ma30 FROM bars, bounds
      LEFT JOIN rolling ON rolling.day = min(${bucketEnd}, finish)
      ORDER BY bucket`,
    [start, end, id],
  );
}

function readRollups(ctx, input, max) {
  const { start, end, ids } = filters(ctx, input);
  const grain = resolution(start, end, input.grain, max);
  const series = ids.map((id) => {
    const meta = ctx.db.query(`SELECT ${SERIES_COLUMNS} FROM series WHERE id = ?`, [id])[0];
    if (!meta) ctx.refuse("unknown_series", "Choose a series that exists.");
    return { ...meta, bars: rollup(ctx, id, start, end, grain) };
  });
  return { start, end, grain, series };
}

function importChunk(ctx, input) {
  const { sha256, filename, total, offset, rows, metadata } = input ?? {};
  if (
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof filename !== "string" ||
    !filename.trim() ||
    filename.length > 255 ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Array.isArray(rows) ||
    rows.length < 1 ||
    rows.length > 512 ||
    offset + rows.length > total ||
    !Array.isArray(metadata) ||
    metadata.length > rows.length
  ) {
    ctx.refuse("invalid_batch", "Send a valid CSV batch of 1 to 512 rows.");
  }
  const previous = ctx.db.query("SELECT * FROM import_batches WHERE sha256 = ?", [sha256])[0];
  const received = previous?.received_rows ?? 0;
  if (previous && previous.row_count !== total)
    ctx.refuse("batch_mismatch", "Retry the import with the original CSV file.");
  if (offset < received) return { received, complete: received === total, inserted: 0 };
  if (offset !== received)
    ctx.refuse("missing_rows", "Resume the import from the first missing row.");

  const used = new Set();
  for (const row of rows) {
    const [slug, at, value, tags] = Array.isArray(row) ? row : [];
    if (typeof slug === "string" && slug.startsWith("sample-"))
      ctx.refuse("sample_series", "Choose a series slug that does not start with sample-.");
    if (
      row?.length !== 4 ||
      typeof slug !== "string" ||
      !SLUG.test(slug) ||
      typeof at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) ||
      !Number.isFinite(Date.parse(at)) ||
      new Date(at).toISOString() !== at ||
      !Number.isFinite(value) ||
      Math.abs(value) > 1e100 ||
      typeof tags !== "string" ||
      tags.length > 2000
    ) {
      ctx.refuse(
        "invalid_row",
        "Check the series, UTC timestamp, value, and tags in each CSV row.",
      );
    }
    try {
      const parsed = JSON.parse(tags);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    } catch {
      ctx.refuse("invalid_tags", "Tags must be a JSON object.");
    }
    used.add(slug);
  }

  const names = new Map();
  for (const item of metadata) {
    const [slug, name, unit, domain] = Array.isArray(item) ? item : [];
    if (
      item?.length !== 4 ||
      !used.has(slug) ||
      names.has(slug) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 80 ||
      typeof unit !== "string" ||
      unit.length > 24 ||
      typeof domain !== "string" ||
      !domain.trim() ||
      domain.length > 32
    ) {
      ctx.refuse("invalid_metadata", "Check the series names, units, and domains.");
    }
    names.set(slug, [name, unit, domain]);
  }
  const info = [...used].map((slug) => {
    const [name, unit, domain] = names.get(slug) ?? [slug, "", "Imported"];
    const color =
      1 + ([...slug].reduce((hash, char) => (31 * hash + char.charCodeAt(0)) % 997, 0) % 6);
    return [slug, slug, name, unit, domain, color];
  });
  insertRows(
    ctx,
    "INSERT INTO series (id, slug, name, unit, domain, color)",
    info,
    " ON CONFLICT(id) DO NOTHING",
  );

  const batch =
    previous?.id ?? ctx.db.query("SELECT coalesce(max(id), 0) + 1 AS id FROM import_batches")[0].id;
  if (!previous) {
    ctx.db.execute(
      "INSERT INTO import_batches (id, filename, sha256, row_count, received_rows) VALUES (?, ?, ?, ?, 0)",
      [batch, filename, sha256, total],
    );
  }
  const next = ctx.db.query("SELECT coalesce(max(id), 0) + 1 AS id FROM observations")[0].id;
  insertRows(
    ctx,
    "INSERT INTO observations (id, series_id, observed_at, value, tags_json, import_batch_id)",
    rows.map((row, index) => [next + index, ...row, batch]),
  );
  const committed = offset + rows.length;
  const complete = committed === total;
  ctx.db.execute("UPDATE import_batches SET received_rows = ?, imported_at_ms = ? WHERE id = ?", [
    committed,
    complete ? ctx.nowMs : null,
    batch,
  ]);
  return { received: committed, complete, inserted: rows.length };
}

function insertRows(ctx, insert, rows, suffix = "") {
  const groupSize = Math.floor(128 / rows[0].length);
  for (let i = 0; i < rows.length; i += groupSize) {
    const group = rows.slice(i, i + groupSize);
    const tuples = group.map((row) => "(" + row.map(() => "?").join(",") + ")");
    ctx.db.execute(insert + " VALUES " + tuples.join(",") + suffix, group.flat());
  }
}

function compare(ctx, input) {
  const { start, end, ids } = filters(ctx, input);
  const lag = input.lag ?? 0;
  if (ids.length !== 2 || !Number.isInteger(lag) || Math.abs(lag) > 30)
    ctx.refuse("invalid_comparison", "Choose two series and a lag from −30 to +30 days.");
  const pairs = `
    WITH
      bounds(start, finish, lag, x_id, y_id) AS (VALUES (?, ?, ?, ?, ?)),
      daily AS (
        SELECT o.series_id, substr(o.observed_at, 1, 10) AS day, avg(o.value) AS value
        ${SOURCE}, bounds
        WHERE o.series_id IN (x_id, y_id)
          AND o.observed_at >= start || 'T00:00:00.000Z'
          AND o.observed_at <= finish || 'T23:59:59.999Z'
        GROUP BY o.series_id, day
      ),
      pairs AS (
        SELECT x.day, y.day AS y_day, x.value AS x, y.value AS y
        FROM bounds
        JOIN daily x ON x.series_id = x_id
        JOIN daily y ON y.series_id = y_id AND y.day = date(x.day, printf('%+d days', lag))
      )`;
  const params = [start, end, lag, ...ids];
  const { n, r } = ctx.db.query(
    `${pairs},
      means AS (SELECT count(*) AS n, avg(x) AS x_mean, avg(y) AS y_mean FROM pairs),
      centered AS (SELECT x - x_mean AS dx, y - y_mean AS dy FROM pairs, means),
      sums AS (SELECT sum(dx * dy) AS xy, sum(dx * dx) AS xx, sum(dy * dy) AS yy FROM centered)
    SELECT n, CASE WHEN n > 1 AND xx > 0 AND yy > 0
      THEN max(-1, min(1, xy / sqrt(xx) / sqrt(yy))) END AS r FROM means, sums`,
    params,
  )[0];
  const points = ctx.db.query(
    `${pairs},
      ranked AS (
        SELECT *, row_number() OVER (ORDER BY day) AS i, count(*) OVER () AS n FROM pairs
      )
    SELECT day, y_day, x, y FROM ranked
    WHERE (i - 1) % max(1, (n + 359) / 360) = 0 ORDER BY day`,
    params,
  );
  return { lag, n, r, rSquared: r === null ? null : r * r, points };
}

function outliers(ctx, input) {
  const { start, end, ids } = filters(ctx, input);
  return ctx.db.query(
    `WITH
      samples AS (
        SELECT o.id, o.series_id, o.observed_at, o.value ${SOURCE}
        WHERE o.series_id IN (?, ?)
          AND o.observed_at >= ?
          AND o.observed_at <= ?
      ),
      means AS (SELECT series_id, avg(value) AS mean FROM samples GROUP BY series_id),
      centered AS (
        SELECT samples.*, value - mean AS delta FROM samples JOIN means USING (series_id)
      ),
      deviations AS (
        SELECT series_id, sqrt(avg(delta * delta)) AS sd FROM centered GROUP BY series_id
      ),
      scores AS (
        SELECT id, series_id, observed_at, value, delta / sd AS z
        FROM centered JOIN deviations USING (series_id) WHERE sd > 0
      )
    SELECT * FROM scores WHERE abs(z) > 2 ORDER BY abs(z) DESC, observed_at, id LIMIT 30`,
    [ids[0], ids[1] ?? null, start + "T00:00:00.000Z", end + "T23:59:59.999Z"],
  );
}

function saveNote(ctx, input) {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const body = typeof input?.body === "string" ? input.body.trim() : "";
  if (!title || title.length > 120 || !body || body.length > 6000)
    ctx.refuse(
      "invalid_note",
      "Enter a title of 1 to 120 characters and a note of 1 to 6,000 characters.",
    );
  const snapshot = readRollups(ctx, input, 96);
  if (snapshot.series.every((series) => series.bars.length === 0))
    ctx.refuse("empty_snapshot", "Choose a date range with observations.");
  ctx.db.execute(
    `INSERT INTO research_notes
      (id, title, body_md, date_start, date_end, series_ids_json, created_at_ms, snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.requestId,
      title,
      body,
      snapshot.start,
      snapshot.end,
      JSON.stringify(input.ids),
      ctx.nowMs,
      JSON.stringify(snapshot),
    ],
  );
  return { id: ctx.requestId };
}

function setReportLink(ctx, input) {
  const { id, grant } = input ?? {};
  if (
    typeof id !== "string" ||
    (grant !== null && (typeof grant !== "string" || !GRANT.test(grant)))
  )
    ctx.refuse("invalid_report", "Choose a note and enter a valid link grant ID.");
  if (
    grant &&
    ctx.db.query("SELECT id FROM research_notes WHERE grant_id = ? AND id <> ?", [grant, id]).length
  )
    ctx.refuse("grant_in_use", "This link already has a report. Remove that link first.");
  const result = ctx.db.execute("UPDATE research_notes SET grant_id = ? WHERE id = ?", [grant, id]);
  if (result.changes !== 1) ctx.refuse("unknown_note", "Choose a saved note.");
  return { id, grant };
}

function report(row) {
  if (!row) return null;
  return {
    title: row.title,
    body: row.body_md,
    createdAt: row.created_at_ms,
    snapshot: JSON.parse(row.snapshot_json),
  };
}

const ownerOperations = {
  overview(ctx) {
    const series = ctx.db.query(
      `SELECT s.id, s.slug, s.name, s.unit, s.domain, s.color, count(*) AS count,
        substr(min(o.observed_at), 1, 10) AS start, substr(max(o.observed_at), 1, 10) AS end
      ${SOURCE} JOIN series s ON s.id = o.series_id
      GROUP BY s.id ORDER BY count DESC, s.id LIMIT 250`,
    );
    const imports = ctx.db.query(
      `SELECT count(*) AS batches, coalesce(sum(row_count), 0) AS observations
      FROM import_batches WHERE imported_at_ms IS NOT NULL`,
    )[0];
    return { series, ...imports };
  },
  importChunk,
  seedDemo,
  rollups: (ctx, input) => readRollups(ctx, input, 400),
  compare,
  outliers,
  analyze(ctx, input) {
    const rollups = readRollups(ctx, input, 400);
    const comparison = input.ids.length === 2 ? compare(ctx, input) : null;
    return { rollups, comparison, outliers: outliers(ctx, input) };
  },
  listNotes(ctx, input) {
    const offset = input?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      ctx.refuse("invalid_offset", "Choose a valid snapshot page.");
    return ctx.db.query(
      `SELECT ${NOTE_COLUMNS} FROM research_notes ORDER BY created_at_ms DESC, id DESC LIMIT 51 OFFSET ?`,
      [offset],
    );
  },
  readNote(ctx, input) {
    const row = ctx.db.query(
      "SELECT title, body_md, created_at_ms, snapshot_json, grant_id FROM research_notes WHERE id = ?",
      [typeof input?.id === "string" ? input.id : ""],
    )[0];
    return row ? { ...report(row), linked: row.grant_id !== null } : null;
  },
  saveNote,
  setReportLink,
};

globalThis.operations = {
  ...Object.fromEntries(
    Object.entries(ownerOperations).map(([name, run]) => [
      name,
      (ctx, input) => {
        if (ctx.caller.kind !== "owner")
          ctx.refuse("forbidden", "Only the owner can use this operation.");
        return run(ctx, input);
      },
    ]),
  ),
  publishedReport(ctx) {
    if (ctx.caller.kind !== "link") return null;
    return report(
      ctx.db.query(
        "SELECT title, body_md, created_at_ms, snapshot_json FROM research_notes WHERE grant_id = ?",
        [ctx.caller.grantId],
      )[0],
    );
  },
};
