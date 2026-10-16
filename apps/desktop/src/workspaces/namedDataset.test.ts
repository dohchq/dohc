import { expect, it, vi } from "vitest";
import { createNamedDatasetData } from "./namedDataset";
import { SHARE_VIEW_REOPEN_MESSAGE } from "./shareViewMarker";

const marker = { shareId: "share", recipientUserId: "helper", relayUrl: "https://relay.example", grantedSelector: { paths: ["apps/form"], versionId: null, access: "view" } };
const input = () => ({ workspaceId: "local-share-copy", shareView: marker, credentials: { serverUrl: "https://account", relayUrl: "https://relay.example", token: "token", userId: "helper", email: "helper@example.test" },
  credentialGeneration: 1, currentCredentialGeneration: () => 1, signal: new AbortController().signal, assertCurrent() {}, relayJson: vi.fn(async () => ({ datasets: [], nextCursor: null })) });
it("routes source-view recipients through share identity without claiming owner or grant authority", async () => {
  const deps = input(), data = createNamedDatasetData(deps);
  expect(await data.list({})).toEqual({ datasets: [], nextCursor: null });
  expect(deps.relayJson).toHaveBeenCalledWith(deps.credentials, "/sync/shares/share/datasets", expect.anything());
  expect(data).not.toHaveProperty("approvedArtifacts");
});
it("refuses ended-share requests with the access reason before transport", () => {
  const deps = input();
  expect(() => createNamedDatasetData({ ...deps, shareView: { ...marker, ended: true } })).toThrow("Your access to this share ended. Ask the owner to share it again.");
  expect(deps.relayJson).not.toHaveBeenCalled();
});
it.each([{ ...marker, recipientUserId: undefined }, { ...marker, shareId: undefined }])("asks to reopen a marker that lost its identity, before any read or write", shareView => {
  const deps = input();
  expect(() => createNamedDatasetData({ ...deps, shareView: { ...shareView, grantedSelector: { ...marker.grantedSelector, access: "edit" } } }))
    .toThrow(SHARE_VIEW_REOPEN_MESSAGE);
  expect(deps.relayJson).not.toHaveBeenCalled();
});
it.each([null, {}, { ...marker, grantedSelector: null }, { ...marker, relayUrl: "https://different" }])("refuses damaged or wrong-origin share markers before transport", shareView => {
  const deps = input();
  expect(() => createNamedDatasetData({ ...deps, shareView })).toThrow();
  expect(deps.relayJson).not.toHaveBeenCalled();
});
