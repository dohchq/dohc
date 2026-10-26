import {afterEach, expect, it} from "vitest";
import {parseAuthenticatedLogOps} from "./relayLogInputs";
import {stableJsonStringify} from "./canonicalJson";
import {claimWorkspace, closeTestStorages, jsonBody, putBlob, request, testHandler, testStorage} from "./testing";

afterEach(closeTestStorages);

function delta(accountId: string) {
  return {actorOriginId: accountId, attribution: {actorKind: "human", depth: 0}, isBaseState: false};
}

it.each(["moment.append", "ydoc.update"])("consumes matching and mismatched recording claims before storing %s", async opKind => {
  for (const accountId of ["owner", "previous-account"]) {
    const storage = await testStorage();
    const handler = testHandler(storage, {lookupUserDisplayName: () => "Owner"});
    await claimWorkspace(handler, "owner", "workspace");
    const sha = await putBlob(handler, "owner", "workspace", "Typing");
    const content = opKind === "moment.append" ? {momentId: "moment", versionId: "main", objectId: "doc", path: "doc.md",
      operation: "write", payloadAfterPath: "doc.md", payloadAfterBlobSha256: sha} : delta(accountId);
    const payload = {...content, authorContext: {kind: "account", accountId}};
    const body = {originId: "device", ops: [{originSeq: 0, opKind, payload, recordedAtMs: 1}]};
    const push = () => handler(request("owner", "/sync/workspace/log", jsonBody(body)));
    expect((await push()).status).toBe(200);
    expect(await (await push()).json()).toMatchObject({inserted: 0, skipped: 1});
    const row = storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 0});
    expect(row?.payloadJson).toBe(stableJsonStringify(content));
    expect(row?.admittedAuthorSnapshot).toEqual(accountId === "owner"
      ? [{kind: "human", humanId: "owner", humanName: "Owner"}] : undefined);
    const page = await (await handler(request("owner", "/sync/workspace/log"))).json();
    expect(page.ops[0].payload).toEqual(content);
    expect(payload).toHaveProperty("authorContext.accountId", accountId);
  }
});

it.each(["moment.append", "ydoc.update"])("drops a %s recording claim and credits the account as Unnamed when account lookup fails", async opKind => {
  const content = opKind === "ydoc.update" ? delta("owner") : {momentId: "moment"};
  const [op] = await parseAuthenticatedLogOps([{originSeq: 0, opKind, recordedAtMs: 1,
    payload: {...content, authorContext: {kind: "account", accountId: "owner"}}}], "owner", () => {throw new Error("offline");});
  expect(op?.payloadJson).toBe(stableJsonStringify(content));
  expect(op?.admittedAuthorSnapshot).toEqual([{kind: "human", humanId: "owner", humanName: "Unnamed"}]);
});

it("consumes a leftover recording claim beside declared moment authors without admitting it", async () => {
  const content = {authors: [{kind:"agent", agentId:"writer"}, {kind:"automation", automationId:"rule", depth:1}]};
  const [op] = await parseAuthenticatedLogOps([{originSeq:0, opKind:"moment.append", recordedAtMs:1,
    payload:{...content, authorContext:{kind:"account", accountId:"owner"}}}], "owner", () => "Owner");
  expect(op?.payloadJson).toBe(stableJsonStringify(content));
  expect(op?.admittedAuthorSnapshot).toBeUndefined();
});

it("preserves main's live, declared-agent, settlement and unrelated payloads", async () => {
  for (const [opKind, fields, context] of [
    ["ydoc.update", {}, {kind: "account", accountId: "owner"}],
    ["ydoc.update", delta("owner"), {kind: "account", accountId: "owner", agent: {agentId: "writer"}}],
    ["moment.append", {settlementReference: {}}, {kind: "account", accountId: "owner"}],
    ["moment.append", {authors: [{kind: "agent", agentId: "writer"}]}, {kind: "account", accountId: "owner", agent: {agentId:"writer"}}],
    ["other", {}, {kind: "account", accountId: "owner"}],
  ] as const) {
    const payload = {...fields, authorContext: context};
    const [op] = await parseAuthenticatedLogOps([{originSeq: 0, opKind, payload, recordedAtMs: 1}], "owner", () => "Owner");
    expect(op?.payloadJson).toBe(stableJsonStringify(payload));
  }
});
