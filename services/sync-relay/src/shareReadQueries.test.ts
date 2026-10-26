import { describe, expect, it, vi } from "vitest";
import { createShareReadQueries } from "./shareReadQueries";
import { filterOpForShare, type ShareSelector } from "./shareFilter";

const selector: ShareSelector = { paths: ["docs"], versionId: null, access: "view" };
const moment = (authors: unknown) => ({
  versionId: "main", operation: "write", path: "docs/plan.md", payloadAfterPath: "docs/plan.md",
  payloadAfterBlobSha256: "a".repeat(64), authors,
  metadata: { origin: "user", summary: "private summary", correlationId: "private correlation" },
});

function page(payload: Record<string, unknown>, audience: "authenticated" | "accountless" = "authenticated",
  admittedAuthorSnapshot?: import("./storage").SyncRelayLogRow["admittedAuthorSnapshot"],
  originId = "owner-origin", shareId = "share") {
  const storage: Pick<Parameters<typeof createShareReadQueries>[0], "fetchLogPage" | "hasRefusedSettlement"> = {
    hasRefusedSettlement: () => false,
    fetchLogPage: () => ({ rows: [{ workspaceId: "workspace", originId, originSeq: 0,
      relaySeq: 1, opKind: "moment.append", payloadJson: JSON.stringify(payload), recordedAtMs: 1, ...(admittedAuthorSnapshot === undefined ? {} : {admittedAuthorSnapshot}) }], nextCursor: 1, hasMore: false }),
  };
  // Selected file moments use only fetchLogPage; the other query surfaces are outside this fixture.
  const queries = createShareReadQueries(storage as unknown as Parameters<typeof createShareReadQueries>[0], 500);
  return queries.filteredLogPage("workspace", shareId, selector, 0, 10, audience);
}

describe("authenticated selected moment declarations", () => {
  it("scopes direct-write origins to the share while keeping retries stable", () => {
    const origin = "relay:collection-file:private-grant";
    const first = page(moment(undefined), "authenticated", undefined, origin, "share-one");
    expect(first.ops[0]!.originId).toBe(page(moment(undefined), "authenticated", undefined, origin, "share-one").ops[0]!.originId);
    expect(first.ops[0]!.originId).not.toBe(page(moment(undefined), "authenticated", undefined, origin, "share-two").ops[0]!.originId);
    expect(JSON.stringify(first)).not.toContain("private-grant");
  });

  it("collapses unavailable authors to one marker in a snapshot", () => {
    const snapshot = [{kind: "agent" as const, agentId: "one"},
      {kind: "agent" as const, agentId: "two", onBehalfOf: "absent"}];
    expect((page(moment(undefined), "authenticated", snapshot).ops[0]!.payload as Record<string, unknown>).authors)
      .toEqual([{kind: "unattributed"}]);
  });
  it("does not publish client-declared people or an agent's onBehalfOf without relay proof", () => {
    const served = page(moment([
      {kind: "human", humanId: "claimed-person", humanName: "Claimed person"},
      {kind: "link", publicPrincipalId: "claimed-public-id", label: "Claimed link"},
      {kind: "agent", agentId: "declared-agent", onBehalfOf: "claimed-person"},
    ]));
    expect((served.ops[0]!.payload as Record<string, unknown>).authors).toEqual([{kind: "unattributed"}]);
    const body = JSON.stringify(served);
    for (const excluded of ["claimed-person", "claimed-public-id", "onBehalfOf", "declared-agent"]) expect(body).not.toContain(excluded);
  });
  it("uses relay snapshots and ignores people in the owner's payload", () => {
    const authors = [{kind: "human" as const, humanId: "recipient", humanName: "Recipient"},
      {kind: "agent" as const, agentId: "assistant", onBehalfOf: "recipient"}];
    const served = page(moment([{kind: "human", humanId: "forged", humanName: "Forged"}]), "authenticated", authors);
    expect((served.ops[0]!.payload as Record<string, unknown>).authors).toEqual(authors);
    expect(JSON.stringify(served)).not.toContain("forged");
  });

  it("serves an agent only with the relay-minted principal in the same list", () => {
    const link = {kind: "link" as const, publicPrincipalId: "public-link", label: "Unverified name"};
    const agent = {kind: "agent" as const, agentId: "assistant", onBehalfOf: "public-link", depth: 2};
    expect((page(moment(undefined), "authenticated", [link, agent]).ops[0]!.payload as Record<string, unknown>).authors)
      .toEqual([link, agent]);
    for (const snapshot of [[agent], [{...agent, onBehalfOf: undefined}]]) {
      expect((page(moment(undefined), "authenticated", snapshot).ops[0]!.payload as Record<string, unknown>).authors)
        .toEqual([{kind: "unattributed"}]);
    }
    expect((page(moment(undefined), "authenticated", [link, {...agent, onBehalfOf: "another-person"}]).ops[0]!.payload as Record<string, unknown>).authors)
      .toEqual([link, {kind: "unattributed"}]);
    expect(page(moment(undefined), "accountless", [link, agent]).ops[0]!.payload).not.toHaveProperty("authors");
  });

  it("leaves ordinary declarations unattributed and the accountless payload minimal", () => {
    const payload = moment([{kind: "agent", agentId: "claimed", onBehalfOf: "claimed-person"},
      {kind: "automation", automationId: "claimed-automation"}]);
    expect((page(payload).ops[0]!.payload as Record<string, unknown>).authors).toEqual([{kind: "unattributed"}]);
    const minimal = filterOpForShare(selector, "moment.append", JSON.stringify(payload));
    expect(minimal.allowed).toBe(true);
    if (!minimal.allowed) throw new Error("Fixture moment was not selected.");
    expect(minimal.payload).not.toHaveProperty("authors");
    expect(page(payload, "accountless").ops[0]!.payload).not.toHaveProperty("authors");
  });

  it("does not carry a declaration past path, version or rename selection", () => {
    const payload = moment([{ kind: "agent", agentId: "hidden-agent" }]);
    for (const override of [
      { path: "private/hidden.md", payloadAfterPath: "private/hidden.md" },
      { versionId: "other-version" },
      { operation: "rename", payloadBeforePath: "private/hidden.md", payloadBeforeBlobSha256: "b".repeat(64) },
    ]) {
      expect(page({ ...payload, ...override }).ops).toEqual([]);
    }
  });

  it("keeps selected content unattributed regardless of malformed or oversized declarations", () => {
    for (const authors of [null, {}, [], [{kind: "agent", agentId: ""}],
      Array(1025).fill({kind: "agent", agentId: "x".repeat(512)})]) {
      const ops = page(moment(authors)).ops;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.payload).toMatchObject({authors: [{kind: "unattributed"}]});
    }
  });

  it("ignores a forged unavailable-attribution mark on an ordinary moment", () => {
    const served = page({...moment(undefined),momentId:"ordinary",
      attributionUnavailable:{settlementId:"invented",reason:"authorship-mismatch"}}).ops[0]!.payload;
    expect((served as Record<string,unknown>).metadata).toEqual({origin:"sync"});
    expect(served).not.toHaveProperty("attributionUnavailable");
  });
});
it("serves only relay-admitted settlement authors, keeps owner bytes, and advances past refused rows",()=>{
 const acceptedPayload={...moment(undefined),momentId:"accepted",settlementReference:{record:{settlementId:"accepted"}}};delete (acceptedPayload as Record<string,unknown>).authors;
 const payloadJson=JSON.stringify(acceptedPayload);
 const authors=[{kind:"human" as const,humanId:"reader",humanName:"Reader"},{kind:"agent" as const,agentId:"trip",agentName:"Trip",onBehalfOf:"reader",depth:2}];
 const rows:import("./storage").SyncRelayLogRow[]=[
 {workspaceId:"workspace",originId:"host",originSeq:0,relaySeq:1,opKind:"moment.append",payloadJson,recordedAtMs:1,admittedAuthorSnapshot:authors,settlementAdmission:{status:"accepted",settlementId:"accepted"}},
 {workspaceId:"workspace",originId:"host",originSeq:1,relaySeq:2,opKind:"moment.append",payloadJson:JSON.stringify({...moment([{kind:"human",humanId:"forged"}]),momentId:"refused"}),recordedAtMs:1,settlementAdmission:{status:"refused",settlementId:"refused",reason:"authorship-mismatch"}},
 {workspaceId:"workspace",originId:"host",originSeq:2,relaySeq:3,opKind:"moment.append",payloadJson:JSON.stringify({...moment(undefined),momentId:"refused",attributionUnavailable:{settlementId:"refused",reason:"authorship-mismatch"}}),recordedAtMs:1}
 ];
 const storage={fetchLogPage:({sinceRelaySeq}:{sinceRelaySeq:number})=>({rows:rows.filter(row=>row.relaySeq>sinceRelaySeq),nextCursor:3,hasMore:false}),
   hasRefusedSettlement:(input:Parameters<import("./storage").SyncRelayStorage["hasRefusedSettlement"]>[0])=>rows.some(row=>
     row.workspaceId === input.workspaceId && row.originId === input.originId && row.originSeq < input.originSeq &&
     row.settlementAdmission?.status === "refused" && row.settlementAdmission.settlementId === input.settlementId &&
     row.settlementAdmission.reason === input.reason && JSON.parse(row.payloadJson).momentId === input.momentId)};
 const queries=createShareReadQueries(storage as unknown as Parameters<typeof createShareReadQueries>[0],500);
 const served=queries.filteredLogPage("workspace", "share",selector,0,10,"authenticated");
 expect(served.ops.map(op=>op.relaySeq)).toEqual([1,3]);expect(served.nextCursor).toBe(3);
 expect(served.ops[0]!.payload).toMatchObject({authors});expect(served.ops[0]).not.toHaveProperty("admittedAuthorSnapshot");expect(served.ops[0]).not.toHaveProperty("settlementAdmission");
 expect(served.ops[0]!.payload).not.toHaveProperty("settlementReference");expect(served.ops[1]!.payload).toMatchObject({authors: [{kind:"unattributed"}]});expect(served.ops[1]!.payload).toMatchObject({metadata:{origin:"sync",summary:"Attribution unavailable"}});
 expect(rows[0]!.payloadJson).toBe(payloadJson);expect(JSON.parse(payloadJson)).not.toHaveProperty("authors");
 const accountless=queries.filteredLogPage("workspace", "share",selector,0,10,"accountless");expect(accountless.ops.map(op=>op.relaySeq)).toEqual([1,3]);expect(accountless.ops[0]!.payload).not.toHaveProperty("authors");
});

it("converts admitted automation to the ordinary moment format only for authenticated shares", () => {
 const payloadJson = JSON.stringify({...moment(undefined), momentId: "automation", settlementReference:{record:{settlementId:"automation"}}});
 const authors = [{kind:"automation" as const, automationId:"collection:Tasks#mark", attribution:{actorKind:"automation" as const,
   onBehalfOf:"presser", depth:2, run:{claimId:"claim",automationName:"Mark task"}}}];
 const row:import("./storage").SyncRelayLogRow = {workspaceId:"workspace",originId:"host",originSeq:0,relaySeq:1,
   opKind:"moment.append",payloadJson,recordedAtMs:1,admittedAuthorSnapshot:authors,settlementAdmission:{status:"accepted",settlementId:"automation"}};
 const storage = {fetchLogPage:()=>({rows:[row],nextCursor:1,hasMore:false})};
 const queries=createShareReadQueries(storage as unknown as Parameters<typeof createShareReadQueries>[0],500);
 expect(queries.filteredLogPage("workspace", "share",selector,0,10,"authenticated").ops[0]?.payload).toMatchObject({
   authors:[{kind:"automation",automationId:"collection:Tasks#mark",onBehalfOf:"presser",depth:2}]});
 expect(queries.filteredLogPage("workspace", "share",selector,0,10,"accountless").ops[0]?.payload).not.toHaveProperty("authors");
 expect(row.admittedAuthorSnapshot).toEqual(authors);
});

it.each([null, "reset", { path: "docs/plan.md", blobSha256: "a".repeat(64), contentKind: "text" }] as const)(
  "caches the current object result %j only within one page", result => {
    const currentObjectFile = vi.fn().mockReturnValue(result);
    const rows = [1, 2].map(relaySeq => ({ workspaceId: "workspace", originId: "origin", originSeq: relaySeq,
      relaySeq, opKind: "moment.append", recordedAtMs: 1,
      payloadJson: JSON.stringify({ ...moment(undefined), objectId: "object", momentId: "moment-" + relaySeq }),
    }));
    const storage = { currentObjectFile, fetchLogPage: () => ({ rows, nextCursor: 2, hasMore: false }) };
    const queries = createShareReadQueries(storage as unknown as Parameters<typeof createShareReadQueries>[0], 500, "current-query-test-key-at-least-32");
    const read = () => queries.filteredLogPage("workspace", "share", selector, 0, 500, "accountless", undefined, ["link", "grant"], true, 7);
    const first = read();
    expect(first.ops).toHaveLength(2);
    expect(currentObjectFile).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace", versionId: "main", objectId: "object", epochLogFloor: 7 });
    expect(first.ops.map(op => op.opKind)).toEqual([result === "reset" ? "files.reset" : "file.current", result === "reset" ? "files.reset" : "file.current"]);
    currentObjectFile.mockReturnValue(null);
    expect(read().ops.map(op => op.payload)).toEqual([
      expect.objectContaining({ file: null }), expect.objectContaining({ file: null }),
    ]);
    expect(currentObjectFile).toHaveBeenCalledTimes(2);
  },
);
