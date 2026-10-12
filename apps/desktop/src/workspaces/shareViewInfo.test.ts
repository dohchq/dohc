import { expect, it } from "vitest";
import { fetchShareViewInfo } from "./shareViewInfo";

it("retains the authenticated source workspace and grant generation for references", async () => {
  const info = await fetchShareViewInfo({ relay: { baseUrl: "https://relay", token: "test", fetch: async () => Response.json({
    ok: true, shareId: "share", sourceWorkspaceId: "source", grantId: "grant", generation: 2,
    genericChatWritable: false, selector: { paths: ["docs"], versionId: null }, access: "view",
  }) }, shareId: "share" });
  expect(info).toMatchObject({ sourceWorkspaceId: "source", grantId: "grant", grantGeneration: 2 });
});

it.each([{}, { sourceWorkspaceId: "source", grantId: "grant", generation: 0 }])("does not invent reference provenance from damaged metadata", async metadata => {
  const info = await fetchShareViewInfo({ relay: { baseUrl: "https://relay", token: "test", fetch: async () => Response.json({
    ...metadata, genericChatWritable: false, selector: { paths: ["docs"], versionId: null }, access: "view",
  }) }, shareId: "share" });
  expect(info.sourceWorkspaceId).toBeUndefined();
});
