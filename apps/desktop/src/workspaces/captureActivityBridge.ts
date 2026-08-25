import type { Event } from "@dohc/workspace-engine-client";
import {
  MAX_ACTIVITY_EVENT_PATHS,
  type WorkspaceActivityScope,
} from "../ipc/workspaceActivityBroadcast";

/** Emitted by the daemon once per settled capture batch / reconcile pass. */
export const CAPTURE_MOMENT_RECORDED_EVENT = "capture.momentRecorded";

const DEFAULT_DEBOUNCE_MS = 100;

// What one debounce window accumulated for a workspace. `paths` is null once
// any event in the window arrived truncated (the daemon caps at
// MAX_ACTIVITY_EVENT_PATHS) or the merged set outgrew the cap — the forward
// then omits the hint and means "refresh broadly".
interface PendingActivity {
  paths: Set<string> | null;
}

// The daemon's bounded capture payload (crates/dohc-workspace-engine
// moment_recorded_payload). Read leniently: this is telemetry for scoping a
// repaint, and a shape drift must degrade to the global ping, never drop it.
function scopeOf(payload: unknown): { workspaceId: string; paths: string[] | null } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.workspaceId !== "string" || record.workspaceId.length === 0) {
    return null;
  }
  const rawPaths = Array.isArray(record.paths)
    ? record.paths.filter((path): path is string => typeof path === "string")
    : null;
  const appliedCount =
    typeof record.appliedCount === "number" ? record.appliedCount : Number.NaN;
  const notOwnedCount =
    typeof record.notOwnedCount === "number" ? record.notOwnedCount : Number.NaN;
  const truncated =
    rawPaths === null ||
    !Number.isFinite(appliedCount) ||
    !Number.isFinite(notOwnedCount) ||
    appliedCount + notOwnedCount > rawPaths.length;
  return { workspaceId: record.workspaceId, paths: truncated ? null : rawPaths };
}

// The daemon records capture moments autonomously — no TS write path runs, so
// nothing else pings the renderer's workspace-activity channel when one lands
// and the history timeline would stay stale forever. Bridge the daemon's
// capture events onto the existing notify seam, debounced per window so a
// multi-file reconcile costs one repaint, and forward the payload's
// workspaceId+paths so only that workspace's windows repaint. An event whose
// payload cannot name a workspace degrades to one global notify for the
// window — under-notifying is the staleness bug this bridge exists to prevent.
export function bridgeCaptureEventsToRenderer(
  daemon: { onEvent(handler: (event: Event) => void): () => void },
  notify: (scope?: WorkspaceActivityScope) => void,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pendingByWorkspace = new Map<string, PendingActivity>();
  let pendingGlobal = false;

  function flush(): void {
    timer = null;
    const scopes = [...pendingByWorkspace.entries()];
    const global = pendingGlobal;
    pendingByWorkspace.clear();
    pendingGlobal = false;
    if (global) {
      // The global ping reaches every window; per-workspace sends on top of
      // it would only repeat the repaint.
      notify();
      return;
    }
    for (const [workspaceId, pending] of scopes) {
      notify({
        workspaceId,
        ...(pending.paths ? { paths: [...pending.paths] } : {}),
      });
    }
  }

  const unsubscribe = daemon.onEvent((event) => {
    if (event.name !== CAPTURE_MOMENT_RECORDED_EVENT) return;
    const scope = scopeOf(event.payload);
    if (!scope) {
      pendingGlobal = true;
    } else {
      const pending = pendingByWorkspace.get(scope.workspaceId) ?? {
        paths: new Set<string>(),
      };
      if (pending.paths && scope.paths) {
        for (const path of scope.paths) pending.paths.add(path);
        if (pending.paths.size > MAX_ACTIVITY_EVENT_PATHS) pending.paths = null;
      } else {
        pending.paths = null;
      }
      pendingByWorkspace.set(scope.workspaceId, pending);
    }
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  });
  return () => {
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingByWorkspace.clear();
    pendingGlobal = false;
  };
}
