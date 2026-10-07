import { describe, expect, it } from "vitest";
import { createShareReadQueries } from "./shareReadQueries";
import { filterOpForShare, type ShareSelector } from "./shareFilter";

const selector: ShareSelector = { paths: ["docs"], versionId: null, access: "view" };
const moment = (authors: unknown) => ({
  versionId: "main", operation: "write", path: "docs/plan.md", payloadAfterPath: "docs/plan.md",
  payloadAfterBlobSha256: "a".repeat(64), authors,
  metadata: { origin: "user", summary: "private summary", correlationId: "private correlation" },
});

function page(payload: Record<string, unknown>, audience: "authenticated" | "accountless" = "authenticated") {
  const storage: Pick<Parameters<typeof createShareReadQueries>[0], "fetchLogPage"> = {
    fetchLogPage: () => ({ rows: [{ workspaceId: "workspace", originId: "owner-origin", originSeq: 0,
      relaySeq: 1, opKind: "moment.append", payloadJson: JSON.stringify(payload), recordedAtMs: 1 }], nextCursor: 1, hasMore: false }),
  };
  // Selected file moments use only fetchLogPage; the other query surfaces are outside this fixture.
  const queries = createShareReadQueries(storage as unknown as Parameters<typeof createShareReadQueries>[0], 500);
  return queries.filteredLogPage("workspace", selector, 0, 10, audience);
}

describe("authenticated selected moment declarations", () => {
  it("rebuilds only declared agents after filtering, while the default and accountless payloads stay minimal", () => {
    const payload = moment([
      { kind: "agent", agentId: "trip-agent 旅行", onBehalfOf: "opaque-relay-owner", depth: 0,
        agentRunId: "private run", displayName: "private display", principalId: "fabricated authority", private: { path: "private/hidden.md" } },
      { kind: "agent", agentId: "chained-agent", onBehalfOf: "local:private-person", depth: 64 },
      { kind: "agent", agentId: "no-principal" },
      { kind: "human", humanId: "private human" },
      { kind: "named", userId: "fabricated user", grantId: "fabricated grant" },
      { kind: "automation", automationId: "private automation", depth: 1 },
    ]);
    const served = page(payload).ops[0]!.payload as Record<string, unknown>;
    expect(served.authors).toEqual([
      { kind: "agent", agentId: "trip-agent 旅行", onBehalfOf: "opaque-relay-owner" },
      { kind: "agent", agentId: "chained-agent", depth: 64 },
      { kind: "agent", agentId: "no-principal" },
    ]);
    expect(served.metadata).toEqual({ origin: "sync" });
    const serialized = JSON.stringify(served);
    for (const excluded of ["private", "fabricated", "agentRunId", "displayName", "correlationId", "local:", "humanId", "automationId", "grantId"]) {
      expect(serialized).not.toContain(excluded);
    }
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

  it("drops malformed optional declarations without dropping the selected file", () => {
    const invalid = [
      { agentId: "" }, { agentId: 1 }, { agentId: "é".repeat(257) }, { agentId: "bad\u0085id" },
      { agentId: "\ud800" }, { agentId: "agent", onBehalfOf: "" },
      { agentId: "agent", onBehalfOf: "bad\nprincipal" }, { agentId: "agent", onBehalfOf: 1 },
      ...[-1, 1.5, 65, null, "1"].map(depth => ({ agentId: "agent", depth })),
    ];
    const served = page(moment([...invalid.map(author => ({ kind: "agent", ...author })),
      { kind: "agent", agentId: "é".repeat(256), onBehalfOf: "owner", depth: 1 },
    ])).ops[0]!.payload as Record<string, unknown>;
    expect(served.authors).toEqual([{ kind: "agent", agentId: "é".repeat(256), onBehalfOf: "owner", depth: 1 }]);
    for (const authors of [null, {}, [], [{ kind: "agent", agentId: "", depth: 0 }]]) {
      const ops = page(moment(authors)).ops;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.payload).not.toHaveProperty("authors");
    }
  });

  it("bounds the projected author count and canonical JSON bytes", () => {
    const author = { kind: "agent", agentId: "agent" };
    expect((page(moment(Array(1_024).fill(author))).ops[0]!.payload as { authors: unknown[] }).authors).toHaveLength(1_024);
    for (const authors of [Array(1_025).fill(author), Array(257).fill({ kind: "agent", agentId: "x".repeat(512) })]) {
      const ops = page(moment(authors)).ops;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.payload).not.toHaveProperty("authors");
    }
  });
});
it("serves only relay-admitted settlement authors, keeps owner bytes, and advances past refused rows",()=>{
 const acceptedPayload={...moment(undefined),momentId:"accepted",settlementReference:{record:{settlementId:"accepted"}}};delete (acceptedPayload as Record<string,unknown>).authors;
 const payloadJson=JSON.stringify(acceptedPayload);
 const authors=[{kind:"human" as const,humanId:"reader",humanName:"Reader"},{kind:"agent" as const,agentId:"trip",agentName:"Trip",onBehalfOf:"reader",depth:2}];
 const rows:import("./storage").SyncRelayLogRow[]=[
 {workspaceId:"workspace",originId:"host",originSeq:0,relaySeq:1,opKind:"moment.append",payloadJson,recordedAtMs:1,admittedAuthorSnapshot:authors,settlementAdmission:{status:"accepted",settlementId:"accepted"}},
 {workspaceId:"workspace",originId:"host",originSeq:1,relaySeq:2,opKind:"moment.append",payloadJson:JSON.stringify({...moment([{kind:"human",humanId:"forged"}]),momentId:"refused"}),recordedAtMs:1,settlementAdmission:{status:"refused",settlementId:"refused",reason:"authorship-mismatch"}},
 {workspaceId:"workspace",originId:"host",originSeq:2,relaySeq:3,opKind:"moment.append",payloadJson:JSON.stringify({...moment(undefined),momentId:"fallback",attributionUnavailable:{settlementId:"refused",reason:"authorship-mismatch"}}),recordedAtMs:1}
 ];
 const storage={fetchLogPage:({sinceRelaySeq}:{sinceRelaySeq:number})=>({rows:rows.filter(row=>row.relaySeq>sinceRelaySeq),nextCursor:3,hasMore:false})};
 const queries=createShareReadQueries(storage as unknown as Parameters<typeof createShareReadQueries>[0],500);
 const served=queries.filteredLogPage("workspace",selector,0,10,"authenticated");
 expect(served.ops.map(op=>op.relaySeq)).toEqual([1,3]);expect(served.nextCursor).toBe(3);
 expect(served.ops[0]!.payload).toMatchObject({authors});expect(served.ops[0]).not.toHaveProperty("admittedAuthorSnapshot");expect(served.ops[0]).not.toHaveProperty("settlementAdmission");
 expect(served.ops[0]!.payload).not.toHaveProperty("settlementReference");expect(served.ops[1]!.payload).not.toHaveProperty("authors");expect(served.ops[1]!.payload).toMatchObject({metadata:{origin:"sync",summary:"Attribution unavailable"}});
 expect(rows[0]!.payloadJson).toBe(payloadJson);expect(JSON.parse(payloadJson)).not.toHaveProperty("authors");
 const accountless=queries.filteredLogPage("workspace",selector,0,10,"accountless");expect(accountless.ops.map(op=>op.relaySeq)).toEqual([1,3]);expect(accountless.ops[0]!.payload).not.toHaveProperty("authors");
});
