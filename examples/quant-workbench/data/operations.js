const DAY = 86_400_000;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const GRANT = /^[a-zA-Z0-9_-]{1,128}$/;
const SERIES_COLUMNS = "id, slug, name, unit, domain";
const MAX_CHUNK_ROWS = 8192;
const NOTE_COLUMNS = "id, title, date_start, date_end, series_ids_json, created_at_ms, grant_id";

const BUCKETS = {
  day: ["substr(observed_at, 1, 10)", "bucket"],
  week: ["date(observed_at, '-6 days', 'weekday 1')", "date(bucket, '+6 days')"],
  month: ["date(observed_at, 'start of month')", "date(bucket, '+1 month', '-1 day')"],
  year: ["date(observed_at, 'start of year')", "date(bucket, '+1 year', '-1 day')"],
};

const SNAPSHOT_PIECE = 12_000;
const REPORT_KIB = 248;
const CATALOG_PAGE = 100;
const MIN_ADJACENT = 9;
const MIN_PAIRS = 10;
const TRENDED = 0.3;
const BASELINE_DAYS = 7;
const NOISE = 1e-13;
const SCATTER_POINTS = 360;
const scale = (column) => `max(abs(max(${column})), abs(min(${column})))`;
const varies = (column) => `max(${column}) - min(${column}) > ${NOISE} * ${scale(column)}`;
const CARRIED = `CASE WHEN x_varies AND y_varies
  THEN max(0, min(0.99, coalesce(xa, 0) / xx * coalesce(ya, 0) / yy)) END`;
const FITS = `n >= ${MIN_PAIRS} AND x_varies AND y_varies`;
const SOURCE = `
  FROM observations AS o
  JOIN import_batches AS b ON b.id = o.import_batch_id AND b.imported_at_ms IS NOT NULL
`;

function seedDemo(ctx) {
  const days = 365;
  const dailySeries = 7;
  const portfolioSlots = 8;
  const expected = days * (dailySeries + portfolioSlots);
  if (ctx.db.query("SELECT id FROM import_batches WHERE imported_at_ms IS NOT NULL LIMIT 1").length)
    return { inserted: 0 };
  insertRows(
    ctx,
    "INSERT INTO series (id, slug, name, unit, domain)",
    [
      ["sample-sleep-hours", "Sleep duration", "h", "Sample health"],
      ["sample-resting-hr", "Resting heart rate", "bpm", "Sample health"],
      ["sample-steps", "Step count", "steps", "Sample health"],
      ["sample-hrv", "Heart rate variability", "ms", "Sample health"],
      ["sample-training-load", "Training load", "AU", "Sample health"],
      ["sample-close", "Portfolio value", "USD", "Sample portfolio"],
      ["sample-volume", "Trading volume", "shares", "Sample portfolio"],
      ["sample-daily-return", "Daily return", "%", "Sample portfolio"],
    ].map((item) => [item[0], ...item]),
  );
  const [{ batch, next }] = ctx.db.query(
    `SELECT (SELECT coalesce(max(id), 0) + 1 FROM import_batches) AS batch,
      (SELECT coalesce(max(id), 0) FROM observations) AS next`,
  );
  ctx.db.execute(
    `INSERT INTO import_batches (id, filename, sha256, row_count, received_rows, imported_at_ms)
    VALUES (?, 'SignalBook sample', ?, ?, ?, ?)`,
    [
      batch,
      "4d95b13b1aff44b5e42c4fc56b5829a0711f653c3fe309f437937c127747ca9c",
      expected,
      expected,
      ctx.nowMs,
    ],
  );
  const { changes } = ctx.db.execute(
    `WITH RECURSIVE
      days(day) AS (VALUES (-2) UNION ALL SELECT day + 1 FROM days WHERE day < 364),
      slots(slot) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7)),
      hashed AS (SELECT day, sin(day * 12.9898) * 43758.5453 AS hash FROM days),
      cores AS (
        SELECT day, 0.58 * sin(day / 11.0) + 1.2 * (hash - floor(hash) - 0.5) - 2 * (day % 89 = 0) AS core
        FROM hashed
      ),
      samples AS (
        SELECT today.day AS day, slot,
          date('2025-01-01', printf('+%d days', today.day)) || printf('T%02d:00:00.000Z', slot * 3) AS stamp,
          sin(today.day * 74.97 + slot * 6.6) AS noise,
          today.day % 89 = 0 AS pulse,
          today.core AS sleep,
          prior.core AS prior_sleep
        FROM cores AS today JOIN cores AS prior ON prior.day = today.day - 2 CROSS JOIN slots
        WHERE today.day >= 0
      )
    INSERT INTO observations (id, series_id, observed_at, value, tags_json, import_batch_id)
    SELECT ?1 + row_number() OVER (ORDER BY day, slot, series.id), series.id, stamp,
      round(CASE series.id
        WHEN 'sample-sleep-hours' THEN 7.2 + sleep + 0.14 * noise
        WHEN 'sample-resting-hr' THEN 62 - 4 * prior_sleep + 1.9 * cos(day / 6.0) + 0.6 * noise
        WHEN 'sample-steps' THEN 7800 + 1700 * sin(day / 8.0) + 1800 * noise + pulse * 9000
        WHEN 'sample-hrv' THEN 54 + 7 * sleep + 6 * sin(day / 21.0) + 3 * noise
        WHEN 'sample-training-load' THEN 58 + 26 * sin(day / 6.0) + 15 * noise + pulse * 65
        WHEN 'sample-close' THEN 24000 + 18 * day + 870 * sin(day / 14.0) + 180 * noise
        WHEN 'sample-volume' THEN 340000 + 110000 * sin(day / 13.0) + 75000 * noise + pulse * 500000
        WHEN 'sample-daily-return' THEN 0.12 + 0.9 * sin(day / 14.0 + 1.57) + 0.25 * noise
      END, 4), '{"source":"demo"}', ?2
    FROM samples CROSS JOIN series
    WHERE series.id LIKE 'sample-%' AND (series.id = 'sample-close' OR slot = 2)`,
    [next, batch],
  );
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

function rollup(ctx, id, start, end, grain, lookback) {
  const [bucket, bucketEnd] = BUCKETS[grain];
  return ctx.db.query(
    `WITH RECURSIVE
      bounds(start, finish) AS (VALUES (?, ?)),
      source AS MATERIALIZED (
        SELECT o.id, o.observed_at, o.value ${SOURCE}, bounds
        WHERE o.series_id = ?
          AND o.observed_at >= date(start, '-${lookback} days') || 'T00:00:00.000Z'
          AND o.observed_at <= finish || 'T23:59:59.999Z'
      ),
      daily AS (
        SELECT substr(observed_at, 1, 10) AS day, avg(value) AS mean
        FROM source GROUP BY day
      ),
      calendar(day) AS (
        SELECT date(start, '-${lookback} days') FROM bounds
        UNION ALL SELECT date(day, '+1 day') FROM calendar, bounds WHERE day < finish
      ),
      rolling AS (
        SELECT day,
          CASE WHEN day >= date(start, '${6 - lookback} days')
            THEN avg(mean) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) END AS ma7,
          CASE WHEN day >= date(start, '${29 - lookback} days')
            THEN avg(mean) OVER (ORDER BY day ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) END AS ma30
        FROM calendar CROSS JOIN bounds LEFT JOIN daily USING (day)
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

function weekChange(ctx, id, start, end) {
  const [row] = ctx.db.query(
    `WITH RECURSIVE
      bounds(start, finish) AS (VALUES (?, ?)),
      daily AS (
        SELECT substr(o.observed_at, 1, 10) AS day, avg(o.value) AS mean ${SOURCE}, bounds
        WHERE o.series_id = ?
          AND o.observed_at >= start || 'T00:00:00.000Z'
          AND o.observed_at <= finish || 'T23:59:59.999Z'
        GROUP BY day
      ),
      calendar(day) AS (
        SELECT start FROM bounds
        UNION ALL SELECT date(day, '+1 day') FROM calendar, bounds WHERE day < finish
      ),
      rolling AS (
        SELECT day, avg(mean) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS ma7
        FROM calendar LEFT JOIN daily USING (day)
      ),
      eligible AS (
        SELECT day, ma7 FROM rolling, bounds
        WHERE day >= date(start, '+6 days') AND ma7 IS NOT NULL
      )
      SELECT julianday(max(day)) - julianday(min(day)) AS span,
        (SELECT ma7 FROM eligible ORDER BY day LIMIT 1) AS first,
        (SELECT ma7 FROM eligible ORDER BY day DESC LIMIT 1) AS last
      FROM eligible`,
    [start, end, id],
  );
  return row.span >= 7 ? { first: row.first, last: row.last } : null;
}

function readRollups(ctx, input, max, lookback = 29) {
  const { start, end, ids } = filters(ctx, input);
  const grain = resolution(start, end, input.grain, max);
  const series = ids.map((id) => {
    const meta = ctx.db.query(`SELECT ${SERIES_COLUMNS} FROM series WHERE id = ?`, [id])[0];
    if (!meta) ctx.refuse("unknown_series", "Choose a series that exists.");
    return { ...meta, bars: rollup(ctx, id, start, end, grain, lookback) };
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
    rows.length > MAX_CHUNK_ROWS ||
    offset + rows.length > total ||
    !Array.isArray(metadata) ||
    metadata.length > rows.length
  ) {
    ctx.refuse("invalid_batch", `Send a valid CSV batch of 1 to ${MAX_CHUNK_ROWS} rows.`);
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
    return [slug, slug, name, unit, domain];
  });
  insertRows(
    ctx,
    "INSERT INTO series (id, slug, name, unit, domain)",
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

function pairing(ctx, input) {
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
  return { lag, pairs, params: [start, end, lag, ...ids], start, end, ids };
}

function effective(n, p, adjacent) {
  if (p === null || adjacent < Math.max(MIN_ADJACENT, n / 2)) return null;
  return Math.round(((n * (1 - p)) / (1 + p)) * 10) / 10;
}

function correlation(ctx, input) {
  return pearson(ctx, pairing(ctx, input));
}

function fit(ctx, { pairs, params }) {
  return ctx.db.query(
    `${pairs},
      means AS (
        SELECT count(*) AS n, avg(x) AS x_mean, avg(y) AS y_mean, min(x) AS x_min, max(x) AS x_max,
          avg(julianday(day)) AS t_mean,
          ${varies("x")} AS x_varies, ${varies("y")} AS y_varies,
          ${scale("x")} AS x_scale, ${scale("y")} AS y_scale
        FROM pairs
      ),
      centered AS MATERIALIZED (
        SELECT day, (x - x_mean) / x_scale AS dx, (y - y_mean) / y_scale AS dy,
          julianday(day) - t_mean AS dt
        FROM pairs, means
      ),
      sums AS (
        SELECT sum(dx * dy) AS xy, sum(dx * dx) AS xx, sum(dy * dy) AS yy,
          sum(dt * dx) AS tx, sum(dt * dy) AS ty, sum(dt * dt) AS tt
        FROM centered
      ),
      carry AS (
        SELECT count(*) AS adjacent, sum(a.dx * b.dx) AS xa, sum(a.dy * b.dy) AS ya
        FROM centered a JOIN centered b ON b.day = date(a.day, '+1 day')
      ),
      fitted AS MATERIALIZED (
        SELECT dx - dt * tx / tt AS ex, dy - dt * ty / tt AS ey FROM centered, sums WHERE tt > 0
      ),
      residuals AS (
        SELECT sum((ex - ex_mean) * (ey - ey_mean)) AS exy,
          sum((ex - ex_mean) * (ex - ex_mean)) AS exx, sum((ey - ey_mean) * (ey - ey_mean)) AS eyy
        FROM fitted, (SELECT avg(ex) AS ex_mean, avg(ey) AS ey_mean FROM fitted)
      )
    SELECT n, adjacent, ${CARRIED} AS p, x_min, x_max,
      CASE WHEN ${FITS} THEN max(-1, min(1, xy / sqrt(xx) / sqrt(yy))) END AS r,
      CASE WHEN ${FITS} THEN y_mean + xy / xx * ((x_min - x_mean) / x_scale) * y_scale END AS y_low,
      CASE WHEN ${FITS} THEN y_mean + xy / xx * ((x_max - x_mean) / x_scale) * y_scale END AS y_high,
      CASE WHEN ${FITS} AND tt > 0 THEN tx / sqrt(tt * xx) END AS x_trend,
      CASE WHEN ${FITS} AND tt > 0 THEN ty / sqrt(tt * yy) END AS y_trend,
      CASE WHEN ${FITS} AND exx > ${NOISE} * xx AND eyy > ${NOISE} * yy
        THEN max(-1, min(1, exy / sqrt(exx) / sqrt(eyy))) END AS partial
    FROM means, sums, carry, residuals`,
    params,
  )[0];
}

function detrended({ x_trend, y_trend, partial }) {
  if (partial === null || Math.min(Math.abs(x_trend), Math.abs(y_trend)) < TRENDED) return null;
  return partial;
}

function pearson(ctx, paired) {
  const { n, adjacent, p, r } = fit(ctx, paired);
  return { lag: paired.lag, n, r, effective: effective(n, p, adjacent) };
}

function compare(ctx, input) {
  const paired = pairing(ctx, input);
  const { lag } = paired;
  const fitted = fit(ctx, paired);
  const { n, adjacent, p, r, x_min, x_max, y_low, y_high } = fitted;
  const { pairs, params } = paired;
  const points = ctx.db.query(
    `${pairs},
      ranked AS (
        SELECT *, row_number() OVER (ORDER BY day) - 1 AS i, count(*) OVER () AS n FROM pairs
      ),
      blocks AS (SELECT *, i * min(n, ${SCATTER_POINTS}) / n AS block FROM ranked),
      placed AS (
        SELECT *, row_number() OVER (PARTITION BY block ORDER BY day) - 1 AS slot,
          count(*) OVER (PARTITION BY block) AS size
        FROM blocks
      )
    SELECT day, y_day, x, y FROM placed
    WHERE slot = (block * 7919 + 13) % size
    ORDER BY day`,
    params,
  );
  return {
    lag,
    n,
    effective: effective(n, p, adjacent),
    r,
    detrended: detrended(fitted),
    line:
      y_low === null
        ? null
        : [
            [x_min, y_low],
            [x_max, y_high],
          ],
    points,
  };
}

function lagProfile(ctx, input) {
  const { start, end, ids } = filters(ctx, input);
  if (ids.length !== 2) return null;
  const rows = ctx.db.query(
    `WITH RECURSIVE
      bounds(start, finish, x_id, y_id) AS (VALUES (?, ?, ?, ?)),
      lags(lag) AS (VALUES (-30) UNION ALL SELECT lag + 1 FROM lags WHERE lag < 30),
      daily AS MATERIALIZED (
        SELECT o.series_id, CAST(julianday(substr(o.observed_at, 1, 10)) AS INTEGER) AS day,
          avg(o.value) AS value
        ${SOURCE}, bounds
        WHERE o.series_id IN (x_id, y_id)
          AND o.observed_at >= start || 'T00:00:00.000Z'
          AND o.observed_at <= finish || 'T23:59:59.999Z'
        GROUP BY o.series_id, day
      ),
      xs AS MATERIALIZED (SELECT day, value FROM daily, bounds WHERE series_id = x_id),
      ys AS MATERIALIZED (SELECT day, value FROM daily, bounds WHERE series_id = y_id),
      pairs AS MATERIALIZED (
        SELECT lag, xs.day, xs.value AS x, ys.value AS y
        FROM lags JOIN xs JOIN ys ON ys.day = xs.day + lag
      ),
      means AS (
        SELECT lag, count(*) AS n, avg(x) AS x_mean, avg(y) AS y_mean,
          ${varies("x")} AS x_varies, ${varies("y")} AS y_varies,
          ${scale("x")} AS x_scale, ${scale("y")} AS y_scale
        FROM pairs GROUP BY lag
      ),
      centered AS MATERIALIZED (
        SELECT lag, day, (x - x_mean) / x_scale AS dx, (y - y_mean) / y_scale AS dy
        FROM pairs JOIN means USING (lag)
      ),
      sums AS (
        SELECT lag, sum(dx * dy) AS xy, sum(dx * dx) AS xx, sum(dy * dy) AS yy
        FROM centered GROUP BY lag
      ),
      carry AS (
        SELECT a.lag, count(*) AS adjacent, sum(a.dx * b.dx) AS xa, sum(a.dy * b.dy) AS ya
        FROM centered a JOIN centered b ON b.lag = a.lag AND b.day = a.day + 1
        GROUP BY a.lag
      )
    SELECT lag, n, coalesce(adjacent, 0) AS adjacent, ${CARRIED} AS p,
      CASE WHEN ${FITS} THEN max(-1, min(1, xy / sqrt(xx) / sqrt(yy))) END AS r
    FROM means JOIN sums USING (lag) LEFT JOIN carry USING (lag) ORDER BY lag`,
    [start, end, ...ids],
  );
  return rows.map(({ adjacent, p, ...row }) => ({
    ...row,
    effective: effective(row.n, p, adjacent),
  }));
}

function outliers(ctx, input) {
  const { start, end, ids } = filters(ctx, input);
  return ctx.db.query(
    `WITH
      daily AS (
        SELECT o.series_id, substr(o.observed_at, 1, 10) AS day, avg(o.value) AS mean ${SOURCE}
        WHERE o.series_id IN (?1, ?2)
          AND o.observed_at >= date(?3, '-30 days') || 'T00:00:00.000Z'
          AND o.observed_at <= ?4
        GROUP BY o.series_id, day
      ),
      baselines AS (
        SELECT series_id, day, avg(mean) OVER trailing AS base, count(mean) OVER trailing AS days
        FROM daily
        WINDOW trailing AS (
          PARTITION BY series_id ORDER BY julianday(day) RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
        )
      ),
      centered AS MATERIALIZED (
        SELECT o.id, o.series_id, o.observed_at, o.value, baselines.base AS mean,
          o.value - baselines.base AS delta ${SOURCE}
        JOIN baselines ON baselines.series_id = o.series_id AND baselines.day = substr(o.observed_at, 1, 10)
        WHERE o.series_id IN (?1, ?2)
          AND o.observed_at >= ?3 || 'T00:00:00.000Z'
          AND o.observed_at <= ?4
          AND baselines.days >= ${BASELINE_DAYS}
      ),
      biases AS (
        SELECT series_id, avg(delta) AS bias, max(max(abs(value)), max(abs(mean))) AS scale
        FROM centered GROUP BY series_id
      ),
      deviations AS (
        SELECT series_id, bias, scale,
          sqrt(avg(((delta - bias) / scale) * ((delta - bias) / scale))) AS spread
        FROM centered JOIN biases USING (series_id) GROUP BY series_id
      ),
      scores AS (
        SELECT id, series_id, observed_at, value, mean + bias AS mean,
          (delta - bias) / scale / spread AS z
        FROM centered JOIN deviations USING (series_id) WHERE spread > ${NOISE}
      )
    SELECT * FROM scores WHERE abs(z) > 2 ORDER BY abs(z) DESC, observed_at, id LIMIT 31`,
    [ids[0], ids[1] ?? null, start, end + "T23:59:59.999Z"],
  );
}

function utf8Bytes(text) {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function saveNote(ctx, input) {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const body = typeof input?.body === "string" ? input.body.trim() : "";
  if (!title || title.length > 120 || !body || body.length > 6000)
    ctx.refuse(
      "invalid_note",
      "Enter a title of 1 to 120 characters and a note of 1 to 6,000 characters.",
    );
  const snapshot = readRollups(ctx, input, 400, 0);
  if (snapshot.series.every((series) => series.bars.length === 0))
    ctx.refuse("empty_snapshot", "Choose a date range with observations.");
  snapshot.changes = snapshot.series.map((series) =>
    weekChange(ctx, series.id, snapshot.start, snapshot.end),
  );
  if (snapshot.series.length === 2) snapshot.comparison = correlation(ctx, input);
  const json = JSON.stringify(snapshot);
  const bytes = utf8Bytes(JSON.stringify({ title, body })) + utf8Bytes(json);
  if (bytes > REPORT_KIB * 1024)
    ctx.refuse(
      "snapshot_too_large",
      `This snapshot and note take ${Math.ceil(bytes / 1024)} KiB, over the ${REPORT_KIB} KiB a saved report can hold. Choose a shorter range, coarser buckets, or a shorter note.`,
    );
  const pieces = [];
  const characters = Array.from(json);
  for (let at = 0; at < characters.length; at += SNAPSHOT_PIECE)
    pieces.push(characters.slice(at, at + SNAPSHOT_PIECE).join(""));
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
      pieces[0],
    ],
  );
  for (const piece of pieces.slice(1))
    ctx.db.execute("UPDATE research_notes SET snapshot_json = snapshot_json || ? WHERE id = ?", [
      piece,
      ctx.requestId,
    ]);
  return { id: ctx.requestId };
}

function setReportLink(ctx, input) {
  const { id, grant, version } = input ?? {};
  if (
    typeof id !== "string" ||
    (grant !== null && (typeof grant !== "string" || !GRANT.test(grant))) ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    ctx.refuse("invalid_report", "Choose a note and enter a valid link ID.");
  if (
    grant &&
    ctx.db.query("SELECT id FROM research_notes WHERE grant_id = ? AND id <> ?", [grant, id]).length
  )
    ctx.refuse("grant_in_use", "This link already has a report. Remove that link first.");
  const [note] = ctx.db.query("SELECT grant_id, link_version FROM research_notes WHERE id = ?", [
    id,
  ]);
  if (!note) ctx.refuse("unknown_note", "Choose a saved note.");
  if (note.grant_id === grant)
    return { id, grant, previous: note.grant_id, version: note.link_version };
  if (note.link_version !== version)
    ctx.refuse(
      "link_changed",
      "This snapshot's report link changed in another window. Check the current link and try again.",
    );
  ctx.db.execute("UPDATE research_notes SET grant_id = ?, link_version = ? WHERE id = ?", [
    grant,
    version + 1,
    id,
  ]);
  return { id, grant, previous: note.grant_id, version: version + 1 };
}

function setShortcuts(ctx, input) {
  if (typeof input?.enabled !== "boolean")
    ctx.refuse("invalid_setting", "Choose whether single-key shortcuts are on.");
  const value = input.enabled ? "on" : "off";
  ctx.db.execute(
    "INSERT INTO settings (key, value) VALUES ('shortcuts', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [value],
  );
  return { enabled: input.enabled };
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
  overview(ctx, input) {
    const query = input?.query ?? "";
    const include = input?.include ?? [];
    if (
      typeof query !== "string" ||
      query.length > 80 ||
      !Array.isArray(include) ||
      include.length > 2 ||
      include.some((id) => typeof id !== "string" || id.length > 64)
    )
      ctx.refuse(
        "invalid_filter",
        "Search with up to 80 characters and keep up to two plotted series.",
      );
    const params = [query.trim().toLowerCase(), include[0] ?? null, include[1] ?? null];
    const listed = `SELECT s.id, s.slug, s.name, s.unit, s.domain, count(*) AS count,
        substr(min(o.observed_at), 1, 10) AS start, substr(max(o.observed_at), 1, 10) AS end,
        max(o.observed_at) AS latest_at,
        (?1 = '' OR instr(lower(s.name), ?1) > 0 OR instr(lower(s.slug), ?1) > 0
          OR instr(lower(s.domain), ?1) > 0) AS matched,
        (SELECT o.value ${SOURCE} WHERE o.series_id = s.id ORDER BY o.observed_at DESC, o.id DESC LIMIT 1)
          AS latest
      ${SOURCE} JOIN series s ON s.id = o.series_id
      WHERE ?1 = '' OR instr(lower(s.name), ?1) > 0 OR instr(lower(s.slug), ?1) > 0
        OR instr(lower(s.domain), ?1) > 0 OR s.id IN (?2, ?3)
      GROUP BY s.id
      ORDER BY s.id IN (?2, ?3) DESC, s.domain, s.name, s.id
      LIMIT ${CATALOG_PAGE}`;
    const series = ctx.db
      .query(listed, params)
      .sort(
        (left, right) =>
          left.domain.localeCompare(right.domain) ||
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id),
      );
    const spark = new Map(series.map((entry) => [entry.id, []]));
    const sparks = [];
    for (let offset = 0; offset < series.length; offset += 64) {
      const group = series.slice(offset, offset + 64);
      sparks.push(
        ...ctx.db.query(
          `WITH
            ends(id, last) AS (VALUES ${group.map(() => "(?, ?)").join(", ")}),
            daily AS (
              SELECT o.series_id AS id,
                CAST(julianday(ends.last) - julianday(substr(o.observed_at, 1, 10)) AS INTEGER) AS ago,
                avg(o.value) AS mean
              ${SOURCE} JOIN ends ON ends.id = o.series_id
              WHERE o.observed_at >= date(ends.last, '-29 days') || 'T00:00:00.000Z'
              GROUP BY o.series_id, substr(o.observed_at, 1, 10)
            )
          SELECT id, json_group_array(json_array(ago, mean)) AS points FROM daily GROUP BY id`,
          group.flatMap((entry) => [entry.id, entry.end]),
        ),
      );
    }
    for (const row of sparks)
      spark.set(
        row.id,
        JSON.parse(row.points).sort((left, right) => right[0] - left[0]),
      );
    const imports = ctx.db.query(
      `SELECT count(*) AS batches, coalesce(sum(row_count), 0) AS observations
      FROM import_batches WHERE imported_at_ms IS NOT NULL`,
    )[0];
    const counts = ctx.db.query(
      `SELECT count(*) AS total,
        coalesce(sum(?1 = '' OR instr(lower(s.name), ?1) > 0 OR instr(lower(s.slug), ?1) > 0
          OR instr(lower(s.domain), ?1) > 0), 0) AS matches
      FROM series s WHERE EXISTS (SELECT 1 ${SOURCE} WHERE o.series_id = s.id)`,
      params.slice(0, 1),
    )[0];
    return {
      series: series.map(({ matched, ...entry }) => ({ ...entry, spark: spark.get(entry.id) })),
      shown: series.filter((entry) => entry.matched).length,
      ...counts,
      ...imports,
      shortcuts:
        ctx.db.query("SELECT value FROM settings WHERE key = 'shortcuts'")[0]?.value !== "off",
    };
  },
  importChunk,
  seedDemo,
  rollups: (ctx, input) => readRollups(ctx, input, 400),
  compare,
  outliers,
  analyze(ctx, input) {
    const rollups = readRollups(ctx, input, 400);
    return { rollups, profile: lagProfile(ctx, input), outliers: outliers(ctx, input) };
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
      "SELECT title, body_md, created_at_ms, snapshot_json, grant_id, link_version FROM research_notes WHERE id = ?",
      [typeof input?.id === "string" ? input.id : ""],
    )[0];
    return row ? { ...report(row), grant: row.grant_id, version: row.link_version } : null;
  },
  saveNote,
  setReportLink,
  setShortcuts,
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
