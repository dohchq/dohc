import { describe, expect, it } from "vitest";
import {
  RelayUnauthorizedError,
  ShareUnavailableError,
} from "@dohc/workspace-contracts/relay";
import {
  listMyShareProposals,
  listShareProposals,
  readShareProposal,
  readShareProposalOp,
  settleShareProposal,
  withdrawShareProposal,
} from "./shareProposalRelay";

// #646 PR3. These pin the granter's review surface against a relay that
// answers with something OTHER than what the wire contract states. A review
// row built from a half-read response tells the granter it is accepting one
// change while the relay holds another, and accepting writes to the
// granter's own workspace — so every parse here refuses rather than softens.

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}

function relayAnswering(
  body: unknown,
  init: { status?: number } = {},
): { relay: { baseUrl: string; token: string; fetch: typeof fetch }; calls: Call[] } {
  const calls: Call[] = [];
  const stub = (async (input: RequestInfo | URL, request?: RequestInit) => {
    const headers = new Headers(request?.headers);
    calls.push({
      url: String(input),
      method: request?.method ?? "GET",
      authorization: headers.get("authorization"),
    });
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    relay: { baseUrl: "https://relay.test/", token: "granter-token", fetch: stub },
    calls,
  };
}

const OP = {
  opIndex: 0,
  basedOnPath: "docs/a.md",
  operation: "write",
  afterPath: "docs/b.md",
  afterBlobSha256: "b".repeat(64),
  afterContentKind: "text",
  afterByteLength: 12,
  currentPath: "docs/a.md",
  drifted: false,
};

const PROPOSAL = {
  proposalId: "proposal-1",
  shareId: "share-1",
  proposedByEmail: "recipient@dohc.test",
  createdAtMs: 10,
  ops: [OP],
};

const SUMMARY = {
  proposalId: "proposal-1",
  shareId: "share-1",
  proposedByEmail: "recipient@dohc.test",
  createdAtMs: 10,
  ops: 1,
};

describe("listShareProposals", () => {
  // A timer polls this, so it states counts. The file rows of one proposal
  // come from readShareProposal, when a granter opens it.
  it("reads the granter's waiting changes as counts", async () => {
    const { relay, calls } = relayAnswering({
      ok: true,
      proposals: [SUMMARY, { ...SUMMARY, proposalId: "proposal-2", ops: 4 }],
    });

    const proposals = await listShareProposals({
      relay,
      workspaceId: "workspace a",
    });

    expect(calls).toEqual([
      {
        url: "https://relay.test/sync/workspace%20a/proposals",
        method: "GET",
        authorization: "Bearer granter-token",
      },
    ]);
    expect(proposals).toEqual([
      SUMMARY,
      { ...SUMMARY, proposalId: "proposal-2", ops: 4 },
    ]);
  });

  // This route serves what the granter still has to ANSWER, so a sender it
  // could not name is stated rather than invented — and the row stays
  // reviewable either way.
  it("states a sender the relay could not name", async () => {
    const { relay } = relayAnswering({
      proposals: [{ ...SUMMARY, proposedByEmail: null }],
    });
    const [proposal] = await listShareProposals({ relay, workspaceId: "workspace-a" });
    expect(proposal?.proposedByEmail).toBeNull();
  });

  it("refuses a count that is not a count, rather than reading it as none", async () => {
    for (const ops of [-1, 1.5, "3", null]) {
      const { relay } = relayAnswering({ proposals: [{ ...SUMMARY, ops }] });
      await expect(
        listShareProposals({ relay, workspaceId: "workspace-a" }),
        `MUTATION: a softened count read renders a review size nobody stated (${String(ops)})`,
      ).rejects.toThrow(/ops is not a non-negative integer/u);
    }
  });

  it("reports the relay's generic lookup failure and its auth failure apart", async () => {
    const missing = relayAnswering({ error: "not_found" }, { status: 404 });
    const unauthorized = relayAnswering({ error: "auth" }, { status: 401 });

    await expect(
      listShareProposals({
        relay: missing.relay,
        workspaceId: "workspace-a",
      }),
    ).rejects.toBeInstanceOf(ShareUnavailableError);
    await expect(
      listShareProposals({
        relay: unauthorized.relay,
        workspaceId: "workspace-a",
      }),
    ).rejects.toBeInstanceOf(RelayUnauthorizedError);
  });
});

// ONE proposal, opened. This is where the op rows are read, so this is where
// their strictness is proved.
describe("readShareProposal", () => {
  const read = (relay: Parameters<typeof readShareProposal>[0]["relay"]) =>
    readShareProposal({ relay, workspaceId: "workspace a", proposalId: "proposal-1" });

  it("reads one proposal's file rows, by id", async () => {
    const { relay, calls } = relayAnswering({ ok: true, proposal: PROPOSAL });

    const proposal = await read(relay);

    expect(calls).toEqual([
      {
        url: "https://relay.test/sync/workspace%20a/proposals/proposal-1",
        method: "GET",
        authorization: "Bearer granter-token",
      },
    ]);
    expect(proposal.ops).toHaveLength(1);
    expect(proposal.ops[0]?.afterByteLength).toBe(12);
  });

  // The relay answering about ANOTHER proposal would put one sender's changes
  // under another sender's name.
  it("refuses a proposal answered for a different id", async () => {
    const { relay } = relayAnswering({
      proposal: { ...PROPOSAL, proposalId: "proposal-9" },
    });
    await expect(
      read(relay),
      "MUTATION: trusting the answered id shows one sender's changes under another's name",
    ).rejects.toThrow(/proposal answered proposal-9 for proposal-1/u);
  });

  it("refuses a drift answer that is not a boolean, rather than reading it as false", async () => {
    const { relay } = relayAnswering({
      proposal: { ...PROPOSAL, ops: [{ ...OP, drifted: "no" }] },
    });

    await expect(
      read(relay),
      "MUTATION: a softened drift read hides that the granter's copy moved",
    ).rejects.toThrow(/drifted is not a boolean/u);
  });

  it("refuses an op whose operation and after side contradict each other", async () => {
    const writeWithoutTarget = relayAnswering({
      proposal: { ...PROPOSAL, ops: [{ ...OP, afterPath: null }] },
    });
    const deleteWithTarget = relayAnswering({
      proposal: { ...PROPOSAL, ops: [{ ...OP, operation: "delete" }] },
    });

    await expect(read(writeWithoutTarget.relay)).rejects.toThrow(
      /write with an after path of null/u,
    );
    await expect(read(deleteWithTarget.relay)).rejects.toThrow(
      /delete with an after path of a path/u,
    );
  });

  it("refuses a drift flag the relay left out rather than reading it as no drift", async () => {
    const { relay } = relayAnswering({
      proposal: { ...PROPOSAL, ops: [{ ...OP, drifted: undefined }] },
    });

    await expect(read(relay)).rejects.toThrow(/drifted is not a boolean/u);
  });
});

// The lazy review's content door. It names ONE op, and what comes back must be
// that op.
describe("readShareProposalOp", () => {
  const readOp = (
    relay: Parameters<typeof readShareProposalOp>[0]["relay"],
    opIndex = 3,
  ) =>
    readShareProposalOp({
      relay,
      workspaceId: "workspace a",
      proposalId: "proposal-1",
      opIndex,
    });

  it("reads the op it asked for, by index", async () => {
    const { relay, calls } = relayAnswering({
      ok: true,
      op: { ...OP, opIndex: 3 },
    });

    const op = await readOp(relay);

    expect(calls[0]?.url).toBe(
      "https://relay.test/sync/workspace%20a/proposals/proposal-1/ops/3",
    );
    expect(op.opIndex).toBe(3);
  });

  // A mismatched index would put one file's content under another file's row —
  // the granter would read a diff for a file they did not open.
  it("refuses an op answered for a different index", async () => {
    const { relay } = relayAnswering({ op: { ...OP, opIndex: 4 } });

    await expect(
      readOp(relay),
      "MUTATION: trusting the answered index shows one file's content under another file's row",
    ).rejects.toThrow(/proposal op answered index 4 for 3/u);
  });

  it("reports the relay's generic lookup failure as an unavailable share", async () => {
    const missing = relayAnswering({ error: "not_found" }, { status: 404 });
    await expect(readOp(missing.relay)).rejects.toBeInstanceOf(ShareUnavailableError);
  });
});

describe("settleShareProposal", () => {
  it("posts the granter's decision and reads back the state that won", async () => {
    const accept = relayAnswering({
      ok: true,
      proposalId: "proposal-1",
      state: "accepted",
    });
    const decline = relayAnswering({
      ok: true,
      proposalId: "proposal-1",
      state: "declined",
    });

    await expect(
      settleShareProposal({
        relay: accept.relay,
        workspaceId: "workspace-a",
        proposalId: "proposal-1",
        decision: "accept",
      }),
    ).resolves.toEqual({ proposalId: "proposal-1", state: "accepted" });
    await expect(
      settleShareProposal({
        relay: decline.relay,
        workspaceId: "workspace-a",
        proposalId: "proposal-1",
        decision: "decline",
      }),
    ).resolves.toEqual({ proposalId: "proposal-1", state: "declined" });
    expect(accept.calls).toEqual([
      {
        url: "https://relay.test/sync/workspace-a/proposals/proposal-1/accept",
        method: "POST",
        authorization: "Bearer granter-token",
      },
    ]);
    expect(decline.calls[0]?.url).toBe(
      "https://relay.test/sync/workspace-a/proposals/proposal-1/decline",
    );
  });

  it("refuses a settlement that answers about another proposal", async () => {
    const { relay } = relayAnswering({
      proposalId: "proposal-9",
      state: "accepted",
    });

    await expect(
      settleShareProposal({
        relay,
        workspaceId: "workspace-a",
        proposalId: "proposal-1",
        decision: "accept",
      }),
    ).rejects.toThrow(/answered proposal-9 for proposal-1/u);
  });
});

describe("listMyShareProposals", () => {
  it("reads the sender's own sent, accepted, and declined proposals", async () => {
    const { relay, calls } = relayAnswering({
      ok: true,
      proposals: [
        {
          proposalId: "proposal-1",
          state: "open",
          createdAtMs: 10,
          settledAtMs: null,
          ops: 3,
        },
        {
          proposalId: "proposal-0",
          state: "declined",
          createdAtMs: 5,
          settledAtMs: 8,
          ops: 1,
        },
      ],
    });

    await expect(
      listMyShareProposals({ relay, shareId: "share/1" }),
    ).resolves.toEqual([
      {
        proposalId: "proposal-1",
        state: "open",
        createdAtMs: 10,
        settledAtMs: null,
        ops: 3,
      },
      {
        proposalId: "proposal-0",
        state: "declined",
        createdAtMs: 5,
        settledAtMs: 8,
        ops: 1,
      },
    ]);
    expect(calls[0]?.url).toBe(
      "https://relay.test/sync/shares/share%2F1/proposals",
    );
  });

  it("refuses a sent proposal whose op count is not a count", async () => {
    const { relay } = relayAnswering({
      proposals: [
        {
          proposalId: "proposal-1",
          state: "open",
          createdAtMs: 10,
          settledAtMs: null,
          ops: "3",
        },
      ],
    });

    await expect(
      listMyShareProposals({ relay, shareId: "share-1" }),
    ).rejects.toThrow(/ops is not a non-negative integer/u);
  });
});

describe("withdrawShareProposal", () => {
  it("takes a sent proposal back and reads the state the relay left it in", async () => {
    const { relay, calls } = relayAnswering({
      ok: true,
      proposalId: "proposal-1",
      state: "withdrawn",
    });

    await expect(
      withdrawShareProposal({
        relay,
        shareId: "share-1",
        proposalId: "proposal-1",
      }),
    ).resolves.toEqual({ proposalId: "proposal-1", state: "withdrawn" });
    expect(calls).toEqual([
      {
        url: "https://relay.test/sync/shares/share-1/proposals/proposal-1/withdraw",
        method: "POST",
        authorization: "Bearer granter-token",
      },
    ]);
  });

  it("refuses a withdraw answer with no state rather than assuming it worked", async () => {
    const { relay } = relayAnswering({ ok: true, proposalId: "proposal-1" });

    await expect(
      withdrawShareProposal({
        relay,
        shareId: "share-1",
        proposalId: "proposal-1",
      }),
    ).rejects.toThrow(/state is not a proposal state/u);
  });
});
