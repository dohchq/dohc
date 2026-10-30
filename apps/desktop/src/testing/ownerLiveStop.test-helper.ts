import { vi } from "vitest";
import { createOwnerLiveDocumentActions, type OwnerLiveDocumentActionDependencies } from "../ipc/relaySharesIpc";
import type { OwnerLiveStop } from "../workspaces/ownerLiveStop";

export function pendingStopHarness(workspaceId: string, path: string, objectId: string,
  options: Partial<Pick<OwnerLiveDocumentActionDependencies<{workspaceId: string}>, "withoutEditors">> = {}) {
  const document = { mainVersionId: "main", objectId, currentPath: path };
  let recorded: OwnerLiveStop | undefined;
  const ownerLiveStop = vi.fn<OwnerLiveDocumentActionDependencies<{workspaceId: string}>["ownerLiveStop"]>(async (_workspace, action) => {
    if (action === "clear") { recorded = undefined; return; }
    recorded = { state: "requested", relayDatabaseNamespace: "relay", retirementOwed: true, document,
      binding: { ...document, workspaceId, lineageClaimId: "a".repeat(64), selectorPaths: [path], restoreFenceGeneration: 0 } };
    return recorded;
  });
  const relay = vi.fn(async (_credentials: unknown, _path: string, _init?: RequestInit): Promise<unknown> => { throw new Error("Live editing didn't stop. Recent edits haven't reached the server yet."); });
  const actions = createOwnerLiveDocumentActions({
    remoteForWorkspace: async () => ({ credentials: { serverUrl: "https://account.test", relayUrl: "https://relay.test",
      userId: "owner", email: "owner@example.test", token: "token" }, credentialGeneration: 1 }),
    currentCredentialGeneration: () => 1,
    relayShareJsonWithCredentials: relay as OwnerLiveDocumentActionDependencies<{workspaceId: string}>["relayShareJsonWithCredentials"],
    ownerLiveStop,
    liveDocument: async () => document,
    withoutEditors: async (_workspace, _path, change) => change(),
    pushRecorded: async () => undefined,
    ownerLiveQuarantines: () => [],
    unwrittenOwnerLiveReleases: async () => [],
    retryOwnerLiveRelease: async () => undefined,
    listOwnerLiveStops: async () => recorded ? [recorded] : [],
    ...options,
  });
  return { actions, document, ownerLiveStop, relay, recorded: () => recorded };
}
