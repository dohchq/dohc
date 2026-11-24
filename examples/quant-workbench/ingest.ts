export type Observation = [slug: string, timestamp: string, value: number, tags: string];
type Metadata = [slug: string, name: string, unit: string, domain: string];
type Batch = {
  sha256: string;
  filename: string;
  total: number;
  offset: number;
  rows: Observation[];
  metadata: Metadata[];
};
type Commit = { received: number; complete: boolean; inserted: number };
export type ImportProgress = {
  filename: string;
  total: number;
  received: number;
  inserted: number;
  commits: number;
  maxInputBytes: number;
  elapsedMs: number;
};

function parseRows(text: string) {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const pushField = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  const pushRow = () => {
    pushField();
    if (row.some((value) => value.trim() !== "")) records.push(row);
    row = [];
  };
  for (let i = text.startsWith("\ufeff") ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (char === ",") pushField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else if (char === '"' && !closed && !field) quoted = true;
    else if (closed || char === '"')
      throw new Error(`CSV record ${records.length + 1} has an unexpected quote.`);
    else field += char;
  }
  if (quoted) throw new Error(`CSV record ${records.length + 1} has an unclosed quote.`);
  pushRow();
  return records;
}

export function parseObservations(text: string) {
  const [header, ...records] = parseRows(text);
  const columns = new Map(header?.map((name, i) => [name.trim(), i]));
  if (
    columns.size !== header?.length ||
    !["series", "observed_at", "value"].every((name) => columns.has(name)) ||
    !records.length
  ) {
    throw new Error(
      "Use a CSV with unique series, observed_at, and value columns and at least one row.",
    );
  }
  const metadata = new Map<string, Metadata>();
  const rows = records.map((row, i): Observation => {
    const get = (key: string) => row[columns.get(key) ?? -1]?.trim() ?? "";
    const fail = (field: string) => {
      throw new Error(`CSV record ${i + 2} has an invalid ${field}.`);
    };
    if (row.length !== header.length) fail("column count");
    const slug = get("series");
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(slug)) fail("series slug");
    if (slug.startsWith("sample-"))
      throw new Error(`CSV record ${i + 2} uses a series slug reserved for sample data.`);
    const at = get("observed_at");
    const day = at.slice(0, 10);
    const dayMs = Date.parse(day);
    const ms = Date.parse(at);
    if (
      !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(at) ||
      !Number.isFinite(ms) ||
      !Number.isFinite(dayMs) ||
      new Date(dayMs).toISOString().slice(0, 10) !== day
    ) {
      fail("timestamp");
    }
    const value = Number(get("value"));
    if (
      !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(get("value")) ||
      !Number.isFinite(value) ||
      Math.abs(value) > 1e100
    )
      fail("value");
    const tags = get("tags_json") || "{}";
    let parsed: unknown;
    try {
      parsed = JSON.parse(tags);
    } catch {
      fail("tags JSON");
    }
    if (tags.length > 2000 || !parsed || typeof parsed !== "object" || Array.isArray(parsed))
      fail("tags JSON object");
    if (!metadata.has(slug)) {
      const name = get("name") || slug;
      const unit = get("unit");
      const domain = get("domain") || "Imported";
      if (name.length > 80 || unit.length > 24 || domain.length > 32) fail("series metadata");
      metadata.set(slug, [slug, name, unit, domain]);
    }
    const timestamp = new Date(ms).toISOString();
    if (timestamp.length !== 24) fail("UTC date");
    return [slug, timestamp, value, tags];
  });
  return { rows, metadata };
}

export async function importObservations(
  filename: string,
  bytes: ArrayBuffer,
  commit: (chunk: Batch) => Promise<Commit>,
  onProgress: (progress: ImportProgress) => void = () => {},
) {
  const started = performance.now();
  const { rows, metadata } = parseObservations(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const encoder = new TextEncoder();
  const byteCount = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const total = rows.length;
  let received = 0;
  let inserted = 0;
  let commits = 0;
  let maxInputBytes = 0;
  const progress = () => ({
    filename,
    total,
    received,
    inserted,
    commits,
    maxInputBytes,
    elapsedMs: performance.now() - started,
  });
  onProgress(progress());
  while (received < total) {
    const batch: Batch = { sha256, filename, total, offset: received, rows: [], metadata: [] };
    const included = new Set<string>();
    let payloadBytes = byteCount(batch);
    for (let index = received; index < total && batch.rows.length < 512; index++) {
      const row = rows[index];
      const slug = row[0];
      const info = included.has(slug) ? undefined : metadata.get(slug);
      const size = byteCount(row) + 1 + (info ? byteCount(info) + 1 : 0);
      if (payloadBytes + size > 48 * 1024) break;
      batch.rows.push(row);
      if (info) {
        included.add(slug);
        batch.metadata.push(info);
      }
      payloadBytes += size;
    }
    const result = await commit(batch);
    if (
      !Number.isSafeInteger(result.received) ||
      result.received <= received ||
      result.received > total ||
      result.complete !== (result.received === total)
    ) {
      throw new Error("The Collection returned an invalid import position.");
    }
    received = result.received;
    inserted += result.inserted;
    commits++;
    maxInputBytes = Math.max(maxInputBytes, byteCount(batch));
    onProgress(progress());
  }
  return progress();
}
