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

function readMap(file: string): DmHomeMap {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { homes?: unknown };
    const homes = parsed.homes;
    if (homes && typeof homes === "object") {
      const out: DmHomeMap = {};
      for (const [shareId, workspaceId] of Object.entries(homes as Record<string, unknown>)) {
        if (typeof workspaceId === "string" && workspaceId) out[shareId] = workspaceId;
      }
      return out;
    }
  } catch {
    // Not created yet (or unreadable) — an empty map.
  }
  return {};
}

function writeMap(file: string, homes: DmHomeMap): void {
  try {
    // mode 0o600 on the temp file is preserved by the rename.
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ homes }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Best-effort persistence; correctness for THIS run still holds via readMap.
  }
}

// The local workspace a received DM `shareId` is homed in, or null if unhomed.
// A cheap short-circuit so a workspace can skip a DM homed elsewhere WITHOUT a
// network peek.
export function readDmHome(file: string, shareId: string): string | null {
  return readMap(file)[shareId] ?? null;
}

// Claim (or confirm) the home workspace for a received DM. Returns TRUE when
// `workspaceId` is (or becomes) the home — i.e. this workspace should auto-join
// the DM — and FALSE when it is homed in another workspace. The read → decide →
// write runs synchronously (no awaits), so concurrent syncDms passes in the
// same process can't both claim an unhomed DM.
export function claimDmHome(file: string, shareId: string, workspaceId: string): boolean {
  const homes = readMap(file);
  const existing = homes[shareId];
  if (existing) return existing === workspaceId;
  homes[shareId] = workspaceId;
  writeMap(file, homes);
  return true;
}
