import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { StorageContext } from "./context";
import { OTHER_LINEAGE_UPDATE } from "./otherLineageUpdate";
import {
  CHECKPOINT_MOMENTS,
  CHECKPOINT_TAIL_ROWS,
  readOrdinaryCheckpoint,
  replaceOrdinaryCheckpoint,
  type OrdinaryCheckpoint,
  type OrdinaryCheckpointMoment,
  type OrdinaryCheckpointRow,
  type OrdinaryCheckpointScope,
} from "./ordinaryActivationCheckpoint";
import type { OrdinaryFoldResult, OrdinaryFoldWork } from "./ordinaryActivationValidation";

/**
 * Folds a lineage's ordinary history into its checkpoint one page at a time. A page holds at most `pageRows` rows of the
 * document and `pageBytes` of payloads and updates, so its read and validation take about as long however long the
 * history is. The fold
 * checks each row as activation's reader does and stops before any row the reader would refuse, so a checkpoint only
 * ever covers rows activation would have accepted.
 */
export interface OrdinaryFoldBounds {
  readonly pageRows: number;
  readonly pageBytes: number;
}
/** The rows one fold page takes. A page of typed keystrokes validates well within 250 ms. */
export const ORDINARY_FOLD_PAGE_ROWS = 1_024;
/** The pages one fold run takes before it saves the checkpoint once. */
export const ORDINARY_FOLD_RUN_PAGES = 16;
type PageMoment = Omit<
  OrdinaryCheckpointMoment,
  "projectedMarkdownSha256" | "projectedMarkdownByteLength"
>;
type PageRow = Omit<OrdinaryCheckpointRow, "projection">;
export type OrdinaryFoldPage =
  | {
      readonly kind: "page";
      readonly scope: OrdinaryCheckpointScope;
      readonly prior: OrdinaryCheckpoint | null;
      readonly base: PageRow;
      /** Null when the page holds only file moments after a checkpoint, which need no validation. */
      readonly work: OrdinaryFoldWork | null;
      /** The file moments before the page's first Y.Doc row: a page ends before a moment, so each follows the page's start. */
      readonly moments: readonly PageMoment[];
      readonly rows: readonly PageRow[];
      readonly throughRelaySeq: number;
      readonly currentPath: string;
      /** Whether the page reached the relay's cursor, so it kept the projections of its last rows. */
      readonly reachedCursor: boolean;
    }
  | { readonly kind: "current" }
  | { readonly kind: "blocked"; readonly relaySeq: number };

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const bytesOf = (value: unknown) => (value instanceof Uint8Array ? new Uint8Array(value) : null);

/**
 * Reads the next page to fold after `prior`, or after the lineage's base when it is null. The page is cut by
 * row count and bytes from each row's stored size first, so no payload or update past the page's bound is read.
 */
export function readOrdinaryFoldPage(
  storage: StorageContext,
  scope: OrdinaryCheckpointScope,
  bounds: OrdinaryFoldBounds,
  prior: OrdinaryCheckpoint | null,
): OrdinaryFoldPage {
  const { document } = scope;
  for (const value of Object.values(bounds))
    if (!integer(value) || value < 1) throw new Error("Invalid ordinary fold bounds.");
  const blocked = (relaySeq: number) => ({ kind: "blocked", relaySeq }) as const;
  // octet_length() reads a column's size from the row's header, and a blob's stored length sits beside its bytes.
  const baseSize = storage.db
    .prepare(`SELECT octet_length(l.payload_json) AS payload_bytes,b.byte_length
    FROM sync_relay_log l LEFT JOIN sync_relay_blobs b ON b.workspace_id=l.workspace_id AND b.sha256=?
    WHERE l.workspace_id=? AND l.relay_seq=?`)
    .get(document.lineageClaimId, document.workspaceId, scope.base.relaySeq);
  if (
    !baseSize ||
    !integer(baseSize.payload_bytes) ||
    !integer(baseSize.byte_length) ||
    Number(baseSize.payload_bytes) + Number(baseSize.byte_length) > bounds.pageBytes
  )
    return blocked(scope.base.relaySeq);
  const baseRow = storage.db
    .prepare(`SELECT l.origin_id,l.origin_seq,l.op_kind,l.relay_admission,l.payload_json,b.content
    FROM sync_relay_log l LEFT JOIN sync_relay_blobs b ON b.workspace_id=l.workspace_id AND b.sha256=?
    WHERE l.workspace_id=? AND l.relay_seq=?`)
    .get(document.lineageClaimId, document.workspaceId, scope.base.relaySeq);
  const basePayload =
    typeof baseRow?.payload_json === "string"
      ? (JSON.parse(baseRow.payload_json) as Record<string, unknown>)
      : null;
  const baseBytes = bytesOf(baseRow?.content);
  if (
    !baseRow ||
    !basePayload ||
    !baseBytes ||
    baseRow.op_kind !== "ydoc.update" ||
    baseRow.origin_id !== scope.base.originId ||
    baseRow.origin_seq !== scope.base.originSeq ||
    basePayload.versionId !== document.mainVersionId ||
    basePayload.objectId !== document.objectId ||
    basePayload.contentKind !== "richdoc" ||
    basePayload.lineageClaimId !== document.lineageClaimId ||
    basePayload.isBaseState !== true ||
    basePayload.updateBlobSha256 !== document.lineageClaimId ||
    typeof basePayload.path !== "string" ||
    hash(baseBytes) !== document.lineageClaimId
  )
    return blocked(scope.base.relaySeq);
  // Every Y.Doc row and write of an activatable lineage is at its base's path; moves between them must return there.
  const documentPath = String(basePayload.path);
  const base: PageRow = {
    relaySeq: scope.base.relaySeq,
    originId: scope.base.originId,
    originSeq: scope.base.originSeq,
    ordinary: baseRow.relay_admission === null,
  };
  const after = prior ? prior.throughRelaySeq : scope.base.relaySeq;
  let path = prior ? prior.currentPath : documentPath;
  const cursor = Number(
    storage.db
      .prepare(
        "SELECT COALESCE(MAX(relay_seq),0) AS cursor FROM sync_relay_log WHERE workspace_id=?",
      )
      .get(document.workspaceId)!.cursor,
  );
  // The note's rows in relay order, with their payload sizes.
  const sizes = storage.db
    .prepare(`SELECT relay_seq,octet_length(payload_json) AS payload_bytes
    FROM sync_relay_log INDEXED BY idx_sync_relay_log_document_page
    WHERE workspace_id=? AND relay_seq>? AND relay_seq<=? AND json_extract(payload_json,'$.versionId')=? AND json_extract(payload_json,'$.objectId')=?
    ORDER BY relay_seq LIMIT ?`)
    .iterate(
      document.workspaceId,
      after,
      cursor,
      document.mainVersionId,
      document.objectId,
      bounds.pageRows + 1,
    );
  const cut: number[] = [],
    payloadThrough = new Map<number, number>();
  let payloadBytes = 0,
    bounded = false;
  for (const row of sizes) {
    const relaySeq = Number(row.relay_seq),
      size = Number(row.payload_bytes);
    if (
      cut.length === bounds.pageRows ||
      !integer(size) ||
      payloadBytes + size > bounds.pageBytes
    ) {
      bounded = true;
      // A row larger than a whole page can never fold.
      if (cut.length === 0) return blocked(relaySeq);
      break;
    }
    payloadBytes += size;
    cut.push(relaySeq);
    payloadThrough.set(relaySeq, payloadBytes);
  }
  const last = cut.at(-1) ?? after;
  /** The page's last row before this one. A page ending here covers it and any other lineage's rows after it. */
  const before = (relaySeq: number) => {
    let found = after;
    for (const seq of cut) {
      if (seq >= relaySeq) break;
      found = seq;
    }
    return found;
  };
  const found =
    cut.length === 0
      ? []
      : storage.db
          .prepare(`SELECT l.relay_seq,l.origin_id,l.origin_seq,l.op_kind,l.relay_admission,l.payload_json,b.byte_length
    FROM sync_relay_log AS l INDEXED BY idx_sync_relay_log_document_page
    LEFT JOIN sync_relay_blobs b ON l.op_kind='ydoc.update' AND b.workspace_id=l.workspace_id AND b.sha256=json_extract(l.payload_json,'$.updateBlobSha256')
    WHERE l.workspace_id=? AND l.relay_seq>? AND l.relay_seq<=? AND json_extract(l.payload_json,'$.versionId')=? AND json_extract(l.payload_json,'$.objectId')=?
      AND COALESCE(json_extract(l.settlement_admission_json,'$.status'),'')<>'refused' AND NOT (${OTHER_LINEAGE_UPDATE})
    ORDER BY l.relay_seq`)
          .all(
            document.workspaceId,
            after,
            last,
            document.mainVersionId,
            document.objectId,
            document.lineageClaimId,
          );
  const objectMoment = storage.db.prepare(
    "SELECT 1 FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=? AND version_id=?",
  );
  const content = storage.db.prepare(
    "SELECT content FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?",
  );
  const moments: PageMoment[] = [],
    rows: PageRow[] = [],
    updates: Uint8Array[] = [];
  let through = last,
    updateBytes = 0,
    stopped: number | null = null,
    full = bounded;
  for (const row of found) {
    const relaySeq = Number(row.relay_seq),
      payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    if (row.op_kind === "moment.append") {
      // The page ends before a moment, so the projection the moment followed is the one the page starts from.
      if (updates.length > 0) {
        through = before(relaySeq);
        full = true;
        break;
      }
      if (
        !(
          payload.payloadAfterContentKind === "text" &&
          typeof payload.momentId === "string" &&
          payload.momentId.length > 0 &&
          digest(payload.payloadAfterBlobSha256) &&
          integer(payload.payloadAfterByteLength) &&
          payload.payloadAfterByteLength <= 2_097_152
        )
      ) {
        stopped = relaySeq;
        break;
      }
      if (payload.operation === "rename") {
        if (
          !(
            typeof payload.payloadAfterPath === "string" &&
            payload.payloadAfterPath.length > 0 &&
            payload.path === payload.payloadAfterPath &&
            payload.payloadBeforePath === path &&
            payload.payloadBeforeContentKind === "text" &&
            payload.payloadBeforeBlobSha256 === payload.payloadAfterBlobSha256
          )
        ) {
          stopped = relaySeq;
          break;
        }
        path = String(payload.payloadAfterPath);
        moments.push({ relaySeq, operation: "rename", write: null });
      } else {
        if (
          !(
            payload.operation === "write" &&
            payload.path === documentPath &&
            payload.payloadAfterPath === documentPath &&
            path === documentPath
          )
        ) {
          stopped = relaySeq;
          break;
        }
        moments.push({
          relaySeq,
          operation: "write",
          write: {
            blobSha256: String(payload.payloadAfterBlobSha256),
            byteLength: Number(payload.payloadAfterByteLength),
            objectMoment: !!objectMoment.get(
              document.workspaceId,
              document.objectId,
              relaySeq,
              document.mainVersionId,
            ),
          },
        });
      }
      continue;
    }
    if (
      !(
        row.op_kind === "ydoc.update" &&
        payload.path === documentPath &&
        path === documentPath &&
        payload.contentKind === "richdoc" &&
        payload.lineageClaimId === document.lineageClaimId &&
        typeof payload.isBaseState === "boolean" &&
        digest(payload.updateBlobSha256) &&
        (!payload.isBaseState || payload.updateBlobSha256 === document.lineageClaimId) &&
        integer(row.byte_length) &&
        integer(row.origin_seq) &&
        typeof row.origin_id === "string" &&
        row.origin_id.length > 0
      )
    ) {
      stopped = relaySeq;
      break;
    }
    // An update past the bound ends the page before its bytes are read; one larger than a whole page can never fold.
    if (payloadThrough.get(relaySeq)! + updateBytes + Number(row.byte_length) > bounds.pageBytes) {
      if (before(relaySeq) === after) return blocked(relaySeq);
      through = before(relaySeq);
      full = true;
      break;
    }
    const bytes = bytesOf(
      content.get(document.workspaceId, String(payload.updateBlobSha256))?.content,
    );
    if (
      !bytes ||
      bytes.length !== Number(row.byte_length) ||
      hash(bytes) !== payload.updateBlobSha256
    ) {
      stopped = relaySeq;
      break;
    }
    updates.push(bytes);
    updateBytes += bytes.length;
    rows.push({
      relaySeq,
      originId: String(row.origin_id),
      originSeq: Number(row.origin_seq),
      ordinary: row.relay_admission === null,
    });
  }
  if (stopped !== null) through = before(stopped);
  if (through === after)
    return stopped !== null
      ? blocked(stopped)
      : prior
        ? { kind: "current" }
        : // A lineage with nothing after its base still folds once, so its checkpoint holds the base's projection.
          {
            kind: "page",
            scope,
            prior,
            base,
            moments,
            rows,
            throughRelaySeq: after,
            currentPath: path,
            reachedCursor: true,
            work: {
              document,
              currentPath: documentPath,
              page: { start: baseBytes, fromBase: true, updates: [], keepFrom: 0 },
            },
          };
  const reachedCursor = stopped === null && !full;
  // A source the engine names is the last ordinary row it applied, so only a page that reached the cursor keeps its last rows' projections.
  const keepFrom = reachedCursor
    ? Math.min(updates.length, Math.max(1, updates.length - CHECKPOINT_TAIL_ROWS + 1))
    : updates.length;
  const work =
    prior && updates.length === 0
      ? null
      : {
          document,
          currentPath: documentPath,
          page: { start: prior ? prior.state : baseBytes, fromBase: !prior, updates, keepFrom },
        };
  return {
    kind: "page",
    scope,
    prior,
    base,
    work,
    moments,
    rows,
    throughRelaySeq: through,
    currentPath: path,
    reachedCursor,
  };
}

/** The page through its first `rows` Y.Doc rows. It ends before the cursor, so it keeps no projections of its last rows. */
function shorterPage(
  page: Extract<OrdinaryFoldPage, { kind: "page" }>,
  rows: number,
): Extract<OrdinaryFoldPage, { kind: "page" }> {
  const work = page.work!;
  return {
    ...page,
    rows: page.rows.slice(0, rows),
    throughRelaySeq: page.rows[rows - 1]!.relaySeq,
    reachedCursor: false,
    work: {
      ...work,
      page: { ...work.page, updates: work.page.updates.slice(0, rows), keepFrom: rows },
    },
  };
}

/** The checkpoint a validated page leaves. */
export function foldedOrdinaryCheckpoint(
  page: Extract<OrdinaryFoldPage, { kind: "page" }>,
  result: Extract<OrdinaryFoldResult, { kind: "folded" }> | null,
): OrdinaryCheckpoint {
  const { prior, rows } = page;
  const start = prior ? prior.projection : result?.base;
  if (!start || (!prior && !result) || (rows.length > 0 && !result))
    throw new Error("Ordinary fold page was not validated.");
  const end = rows.length > 0 ? result!.projection : start;
  const kept = new Map(
    (result?.prefixes ?? []).map(({ index, ...projection }) => [index, projection]),
  );
  // Prefix i is the history through the page's row i-1; the last prefix is the page's end.
  const folded = rows.map((row, index) => ({
    ...row,
    projection: index === rows.length - 1 ? end : (kept.get(index + 1) ?? null),
  }));
  const tail = [...(prior ? prior.tail : [{ ...page.base, projection: start }]), ...folded].slice(
    -CHECKPOINT_TAIL_ROWS,
  );
  let moments = [
    ...(prior ? prior.moments : []),
    ...page.moments.map((moment) => ({ ...moment, ...start })),
  ];
  let momentsFromSeq = prior ? prior.momentsFromSeq : page.base.relaySeq;
  if (moments.length > CHECKPOINT_MOMENTS) {
    momentsFromSeq = moments[moments.length - CHECKPOINT_MOMENTS - 1]!.relaySeq + 1;
    moments = moments.slice(-CHECKPOINT_MOMENTS);
  }
  // Activation's reader takes the same latest rename and object write from the rows it walks.
  let latestRename = prior ? prior.latestRename : null,
    latestWrite = prior ? prior.latestWrite : null;
  for (const { relaySeq, operation, write } of page.moments) {
    if (operation === "rename") latestRename = relaySeq;
    else if (write?.objectMoment)
      latestWrite = { relaySeq, blobSha256: write.blobSha256, byteLength: write.byteLength };
  }
  const state = rows.length > 0 || !prior ? result!.state : prior.state;
  return {
    throughRelaySeq: page.throughRelaySeq,
    foldedEntries: (prior ? prior.foldedEntries : 1) + rows.length,
    state,
    stateSha256: rows.length > 0 || !prior ? result!.stateSha256 : prior.stateSha256,
    currentPath: page.currentPath,
    projection: end,
    tail,
    moments,
    momentsFromSeq,
    latestRename,
    latestWrite,
  };
}

export type OrdinaryFoldValidator = (
  work: OrdinaryFoldWork,
  signal?: AbortSignal,
) => Promise<
  | OrdinaryFoldResult
  | { kind: "capacity-refused" }
  | { kind: "retry"; reason: "admission-unavailable" }
>;
export type OrdinaryFoldOutcome =
  | { kind: "folded"; throughRelaySeq: number; reachedCursor: boolean }
  | { kind: "current" }
  | { kind: "blocked"; relaySeq: number }
  | { kind: "refused"; message: string }
  | { kind: "over-budget"; message: string }
  | { kind: "busy" }
  | { kind: "lost" };
/**
 * Folds up to `pages` of the lineage's next pages and saves the checkpoint they leave in one short transaction. Each page
 * reads from the checkpoint the page before it left, and the run ends early at the cursor, at a row the fold cannot take,
 * or at a page validation that does not fold; the pages folded before that are saved. Validation runs off the event loop
 * and outside any transaction, and the event loop takes a turn before each page read and before the save. Another fold
 * that saved first, or a relay that no longer holds the rows, leaves this one `lost`.
 */
export async function foldOrdinaryCheckpointPages(
  storage: StorageContext,
  input: {
    scope: OrdinaryCheckpointScope;
    bounds: OrdinaryFoldBounds;
    pages: number;
    validate: OrdinaryFoldValidator;
    nowMs: () => number;
    signal?: AbortSignal;
  },
): Promise<OrdinaryFoldOutcome> {
  if (!integer(input.pages) || input.pages < 1) throw new Error("Invalid ordinary fold run.");
  const saved = readOrdinaryCheckpoint(storage, input.scope);
  let checkpoint = saved,
    folded: Extract<OrdinaryFoldOutcome, { kind: "folded" }> | null = null,
    ended: OrdinaryFoldOutcome | null = null;
  for (let pages = 0; pages < input.pages && !folded?.reachedCursor; pages++) {
    await setImmediate();
    input.signal?.throwIfAborted();
    const read = readOrdinaryFoldPage(storage, input.scope, input.bounds, checkpoint);
    if (read.kind !== "page") {
      ended = read;
      break;
    }
    let page = read,
      result: Extract<OrdinaryFoldResult, { kind: "folded" }> | null = null;
    if (page.work) {
      let validated = await input.validate(page.work, input.signal);
      if (validated.kind === "unprojected") {
        // A page that ends at a state no live document has ends instead at an earlier row whose state is one. It tries
        // ends 1, 2, 4 and more rows back until one folds, then halves the rows between the longest page known to fold
        // and the shortest known not to. That costs at most about 20 more validations. A page whose last rows are such
        // states ends at the row before them, unless an earlier run of such states holds every end it tries.
        let folds = 0,
          fails = read.rows.length,
          back = 1,
          found: {
            page: typeof page;
            result: Extract<OrdinaryFoldResult, { kind: "folded" }>;
          } | null = null;
        while (fails - folds > 1 && validated.kind === "unprojected") {
          input.signal?.throwIfAborted();
          const rows =
            found || back >= read.rows.length ? (folds + fails) >> 1 : read.rows.length - back;
          back *= 2;
          const shorter = shorterPage(read, rows),
            tried = await input.validate(shorter.work!, input.signal);
          if (tried.kind === "folded") {
            folds = rows;
            found = { page: shorter, result: tried };
          } else if (tried.kind === "unprojected") fails = rows;
          else validated = tried;
        }
        if (found && validated.kind === "unprojected") {
          page = found.page;
          validated = found.result;
        }
      }
      if (validated.kind !== "folded") {
        ended =
          validated.kind === "capacity-refused" || validated.kind === "retry"
            ? { kind: "busy" }
            : {
                kind: validated.kind === "over-budget" ? "over-budget" : "refused",
                message: validated.message,
              };
        break;
      }
      result = validated;
    }
    checkpoint = foldedOrdinaryCheckpoint(page, result);
    folded = {
      kind: "folded",
      throughRelaySeq: page.throughRelaySeq,
      reachedCursor: page.reachedCursor,
    };
  }
  if (!folded || !checkpoint) return ended!;
  await setImmediate();
  const kept = checkpoint;
  if (
    !storage.tx(() =>
      replaceOrdinaryCheckpoint(storage, {
        scope: input.scope,
        expected: saved ? saved.throughRelaySeq : null,
        checkpoint: kept,
        nowMs: input.nowMs(),
      }),
    )
  )
    return { kind: "lost" };
  // A run that stopped at the cursor or at a row it cannot take reports what it folded; the next run finds where it stopped.
  return ended && ended.kind !== "current" && ended.kind !== "blocked" ? ended : folded;
}
