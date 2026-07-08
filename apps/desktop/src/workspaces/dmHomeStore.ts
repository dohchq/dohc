import { readFileSync, renameSync, writeFileSync } from "node:fs";

// Account-level DM homing map (WS-MU-C3 fix — cross-workspace DM
// contamination): received DM grants are ACCOUNT-wide, and received summaries
// omit the granter workspace id, so without pinning, opening Chats in Work AND
// Personal would materialize the SAME remote DM into BOTH local workspaces —
// violating dohc's workspace-scoping invariant (every share is scoped to one
// workspace). This map pins each received DM (by shareId) to EXACTLY ONE local
// workspace via a persistent record in the ACCOUNT/user data dir (stateDir),
// NOT any single workspace's engine db — the map spans every workspace.
//
// Placement is deterministic first-open: the first workspace whose syncDms
// processes an unhomed DM claims it; every other workspace skips it thereafter.
// The write is ATOMIC (temp file + rename, matching localReactorId /
// cloudCredentialStore) so a crash can never leave a half-written map.

type DmHomeMap = Record<string, string>;

// Reading the map has THREE outcomes, and conflating them reopens the
// cross-workspace-contamination bug:
//   { ok: true, homes }  — the map was read (possibly a genuinely empty {}).
//   ok:false             — the file exists but could NOT be read/parsed (a
//                          transient fs error or corruption). We must NOT assume
//                          "empty" here — rewriting from an assumed-empty map
//                          would DROP every other DM's home pin.
// Only a missing file (ENOENT) is a genuine "unhomed, empty map".
type ReadResult = { ok: true; homes: DmHomeMap } | { ok: false };

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function readMap(file: string): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    // ENOENT = the map has simply never been written → genuinely empty/unhomed.
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { ok: true, homes: {} };
    }
    // Any OTHER read error (permissions, transient fs) → we cannot confirm the
    // map's contents. Fail closed: never let a claim clobber existing pins.
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(raw) as { homes?: unknown };
    const homes = parsed.homes;
    const out: DmHomeMap = {};
    if (homes && typeof homes === "object") {
      for (const [shareId, workspaceId] of Object.entries(homes as Record<string, unknown>)) {
        if (typeof workspaceId === "string" && workspaceId) out[shareId] = workspaceId;
      }
    }
    return { ok: true, homes: out };
  } catch {
    // A present-but-unparseable file: don't assume empty (that would drop pins
    // on the next claim). Fail closed.
    return { ok: false };
  }
}

// Persist the map ATOMICALLY (temp file + rename). Returns whether the write
// actually reached disk — a claim is only "won" when durably persisted.
function writeMap(file: string, homes: DmHomeMap): boolean {
  try {
    // mode 0o600 on the temp file is preserved by the rename.
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ homes }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// The local workspace a received DM `shareId` is homed in, or null if unhomed.
// A cheap short-circuit so a workspace can skip a DM homed elsewhere WITHOUT a
// network peek. On an unreadable map this returns null ("cannot confirm here"),
// which just declines the short-circuit — the real gate is claimDmHome, which
// fails closed on the same error, so nothing wrongly proceeds.
export function readDmHome(file: string, shareId: string): string | null {
  const result = readMap(file);
  return result.ok ? (result.homes[shareId] ?? null) : null;
}

// Claim (or confirm) the home workspace for a received DM. Returns TRUE only
// when `workspaceId` is (or durably becomes) the home — i.e. this workspace
// should auto-join the DM. Returns FALSE when the DM is homed elsewhere, when
// the map can't be read (fail closed — never clobber other pins), OR when a new
// claim can't be persisted (an unpersisted claim would let another workspace
// reclaim the same DM after a restart and duplicate the auto-join). The
// read → decide → write runs synchronously (no awaits), so concurrent syncDms
// passes in the same process can't both claim an unhomed DM.
export function claimDmHome(file: string, shareId: string, workspaceId: string): boolean {
  const result = readMap(file);
  if (!result.ok) return false;
  const existing = result.homes[shareId];
  if (existing) return existing === workspaceId;
  result.homes[shareId] = workspaceId;
  return writeMap(file, result.homes);
}
