import {normalizeShareLabel, type ShareLabels} from "@dohc/security-contract/share-labels";
export async function ownerShareLabels(input: {
  rootPath: string; selector: {paths?: unknown; channelWireId?: unknown}; sharerName: string;
  groupName(wireId: string): Promise<string | null>;
  appName?(path: string): Promise<string | null>;
}): Promise<ShareLabels> {
  const paths = Array.isArray(input.selector.paths) ? input.selector.paths.filter((p): p is string => typeof p === "string") : [];
  const leaf = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  const isGroup = typeof input.selector.channelWireId === "string";
  const group = isGroup ? await input.groupName(input.selector.channelWireId as string) : null;
  const app = !group && paths.length === 1 ? await input.appName?.(paths[0]!) : null;
  return {subjectName: normalizeShareLabel(group ?? app ?? (paths.length ? paths.map(leaf).join(", ") : isGroup ? null : leaf(input.rootPath))),
    sharerName: normalizeShareLabel(input.sharerName)};
}

export async function refreshOwnerShareLabels(input: {
  workspaceId: string;
  list(): Promise<{granted: Array<{shareId: string; workspaceId: string; selector: unknown; subjectName?: string | null; sharerName?: string | null}>}>;
  labels(selector: {paths?: unknown; channelWireId?: unknown}): Promise<ShareLabels>;
  update(shareId: string, labels: ShareLabels): Promise<unknown>;
}): Promise<void> {
  const seen = new Set<string>();
  for (const row of (await input.list()).granted) {
    if (row.workspaceId !== input.workspaceId || seen.has(row.shareId) || !row.selector || typeof row.selector !== "object") continue;
    seen.add(row.shareId);
    const labels = await input.labels(row.selector);
    if (labels.subjectName !== row.subjectName || labels.sharerName !== row.sharerName) await input.update(row.shareId, labels);
  }
}

// A sync pass can be frequent. Labels refresh in the background, with one
// request at a time and the same ten-minute cadence as the share roster.
export function createOwnerShareLabelRefresh(failed: (error: unknown) => void, now = Date.now) {
  const workspaces = new Map<string, {pending: boolean; next: number}>();
  return (workspaceId: string, refresh: () => Promise<void>) => {
    const state = workspaces.get(workspaceId) ?? {pending: false, next: 0};
    if (state.pending || now() < state.next) return;
    workspaces.set(workspaceId, state);
    state.pending = true;
    state.next = now() + 10 * 60_000;
    void refresh().catch(failed).finally(() => {state.pending = false;});
  };
}
