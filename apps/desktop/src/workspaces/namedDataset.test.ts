import { expect, it, vi } from "vitest";
import { createNamedDatasetData } from "./namedDataset";

const marker = { shareId: "share", relayUrl: "https://relay.example", grantedSelector: { paths: ["apps/form"], versionId: null, access: "view" } };
const input = () => ({ workspaceId: "local-share-copy", shareView: marker, credentials: { serverUrl: "https://account", relayUrl: "https://relay.example", token: "token", userId: "helper", email: "helper@example.test" },
  credentialGeneration: 1, currentCredentialGeneration: () => 1, signal: new AbortController().signal, assertCurrent() {}, relayJson: vi.fn(async () => ({ datasets: [], nextCursor: null })) });
it("routes source-view recipients through share identity without claiming owner or grant authority", async () => {
  const deps = input(), data = createNamedDatasetData(deps);
  expect(await data.list({})).toEqual({ datasets: [], nextCursor: null });
  expect(deps.relayJson).toHaveBeenCalledWith(deps.credentials, "/sync/shares/share/datasets", expect.anything());
  expect(data).not.toHaveProperty("approvedArtifacts");
});
it.each([null, {}, { ...marker, ended: true }, { ...marker, grantedSelector: null }, { ...marker, relayUrl: "https://different" }])("refuses damaged, revoked or wrong-origin share markers before transport", shareView => {
  const deps = input();
  expect(() => createNamedDatasetData({ ...deps, shareView })).toThrow();
  expect(deps.relayJson).not.toHaveBeenCalled();
});
