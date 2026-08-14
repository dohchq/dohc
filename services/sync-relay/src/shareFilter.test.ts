import { describe, expect, it } from "vitest";
import {
  MAX_SHARE_VERSION_ID_CHARS,
  isValidShareVersionId,
} from "@dohc/security-contract/share-selector";
import {
  MAX_CHANNEL_WIRE_ID_CHARS,
  MAX_SHARE_PATHS,
  filterOpForShare,
  parseAnyShareSelectorJson,
  parseChatThreadTopic,
  parseShareSelectorJson,
  presenceTopicAllowedForShare,
  validateChatChannelShareSelector,
  validateShareSelector,
  type ChatChannelShareSelector,
  type ChatShareThreadResolver,
  type ShareSelector,
} from "./shareFilter";

function momentPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    momentId: "moment-1",
    versionId: "main",
    objectId: "object-1",
    path: "docs/a.md",
    recordedAtMs: 1000,
    operation: "write",
    payloadBeforeBlobSha256: null,
    payloadBeforePath: null,
    payloadAfterBlobSha256: "a".repeat(64),
    payloadAfterPath: "docs/a.md",
    metadata: { origin: "user" },
    beforePresent: "null",
    ...overrides,
  });
}

const pathShare: ShareSelector = { paths: ["docs"], versionId: null, access: "view" };

describe("share selector validation", () => {
  it("accepts explicit tracked paths and normalizes/dedupes them", () => {
    const result = validateShareSelector({
      paths: ["docs/notes.md", "docs//notes.md", "src"],
      access: "view",
    });
    expect(result).toEqual({
      ok: true,
      selector: { paths: ["docs/notes.md", "src"], versionId: null, access: "view" },
    });
  });

  it("accepts every level, and mints nothing when the caller names none", () => {
    for (const access of ["view", "comment", "edit"] as const) {
      expect(validateShareSelector({ paths: ["docs"], access })).toMatchObject({
        ok: true,
        selector: { access },
      });
    }
    // No default. A share is MINTED here, so a caller that sends nothing has
    // not chosen `view` — it has failed to say what the share grants, and
    // the relay refuses rather than choosing on its behalf.
    expect(
      validateShareSelector({ paths: ["docs"] }),
      "MUTATION: a share must never be minted at a level nobody asked for",
    ).toMatchObject({ ok: false, code: "invalid_access" });
  });

  it("refuses every access value that is not exactly view, comment, or edit", () => {
    for (const access of ["View", "COMMENT", " view", "view ", "viewer", "read-write", 42, null]) {
      const result = validateShareSelector({ paths: ["docs"], access });
      expect(result.ok, JSON.stringify(access)).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_access");
    }
  });

  it("refuses secret-classified paths at grant time, including encoded disguises", () => {
    for (const path of [".env", "config/.env", "app.env", ".env.local", "secrets%2eenv"]) {
      const result = validateShareSelector({ paths: [path] });
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.code).toBe("secret_path");
    }
  });

  it("refuses traversal, absolute, and reserved paths", () => {
    for (const path of ["../outside.md", "/etc/passwd", "..%2f..%2fescape", ".dohc/engine/engine.db", "a/../../b"]) {
      const result = validateShareSelector({ paths: [path] });
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(["invalid_path", "secret_path"]).toContain(result.code);
    }
  });

  it("refuses shared-with-me selector paths (no transitive sharing of mounted shares)", () => {
    for (const path of ["shared-with-me/alex/brief.md", "Shared-With-Me/alex", "shared-with-me"]) {
      const result = validateShareSelector({ paths: [path] });
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_path");
    }
  });

  it("requires at least one path or a version and caps the path count", () => {
    expect(validateShareSelector({})).toMatchObject({ ok: false, code: "empty_selector" });
    expect(validateShareSelector({ paths: [] })).toMatchObject({ ok: false, code: "empty_selector" });
    expect(
      validateShareSelector({ paths: Array.from({ length: MAX_SHARE_PATHS + 1 }, (_, i) => `f${i}.md`) }),
    ).toMatchObject({ ok: false, code: "too_many_paths" });
    expect(
      validateShareSelector({ versionId: "version-1", access: "view" }),
    ).toMatchObject({ ok: true });
    expect(validateShareSelector({ versionId: "  padded " })).toMatchObject({
      ok: false,
      code: "invalid_version",
    });
  });

  // The version rule is shared with every recipient surface that reads a
  // selector BACK (the desktop's share metadata parse and its registry
  // record). Restating it per surface is what let "" through one reader while
  // this one refused it — a no-paths selector that carries a version grants
  // the whole tracked workspace.
  it("refuses every version id the shared rule refuses", () => {
    for (const versionId of ["", "   ", " v1", "v1 ", "v".repeat(MAX_SHARE_VERSION_ID_CHARS + 1)]) {
      expect(
        validateShareSelector({ versionId }),
        `MUTATION: accepting ${JSON.stringify(versionId)} makes a no-paths selector a whole-workspace grant`,
      ).toMatchObject({ ok: false, code: "invalid_version" });
      expect(isValidShareVersionId(versionId)).toBe(false);
    }
    expect(
      validateShareSelector({
        versionId: "v".repeat(MAX_SHARE_VERSION_ID_CHARS),
        access: "view",
      }),
    ).toMatchObject({ ok: true });
  });

  // An oversized id has to say HOW oversized. The limit alone reads the same
  // for 129 code units and for 10,000, and the caller cannot tell whether it
  // is one character over or sending the wrong field entirely. The engine's
  // twin refusal already names the observed length; this is the same rule
  // answering on the same terms.
  it("names the observed length when a version id is too long", () => {
    const barelyOver = validateShareSelector({
      versionId: "v".repeat(MAX_SHARE_VERSION_ID_CHARS + 1),
    });
    const wildlyOver = validateShareSelector({
      versionId: "v".repeat(10_000),
    });
    if (barelyOver.ok || wildlyOver.ok) throw new Error("both must be refused");

    expect(
      barelyOver.message,
      "MUTATION: a limit with no observed length reads the same at 129 and at 10,000",
    ).toContain(`${MAX_SHARE_VERSION_ID_CHARS + 1}`);
    expect(wildlyOver.message).toContain("10000");
    expect(barelyOver.message).not.toBe(wildlyOver.message);
    // The unit stays the one the rule measures.
    expect(barelyOver.message).toContain("UTF-16 code units");
  });

  it("round-trips through selector JSON and rejects malformed persisted selectors", () => {
    const validated = validateShareSelector({ paths: ["docs"], versionId: "v-1", access: "comment" });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const json = JSON.stringify(validated.selector);
    expect(parseShareSelectorJson(json)).toEqual(validated.selector);
    expect(parseShareSelectorJson("not json")).toBeNull();
    expect(parseShareSelectorJson('{"paths":"docs","versionId":null,"access":"view"}')).toBeNull();
    expect(parseShareSelectorJson('{"paths":[1],"versionId":null,"access":"view"}')).toBeNull();
  });

  // A stored row missing `access` (pre-#646) or naming a level the relay
  // never issues must fail closed to null, never resurrect into "view" — the
  // create-time default in validateShareSelector is a create-time-only
  // convenience (decision G), and this is the row-reload rule mirroring the
  // chat-channel selector's identical posture at line 277-287.
  it("fails a stored row closed to null when access is missing or unrecognized, even though create-time defaults it", () => {
    expect(
      parseShareSelectorJson('{"paths":["docs"],"versionId":null}'),
      "MUTATION: a stored row with no access must not silently become view",
    ).toBeNull();
    for (const access of ["View", "COMMENT", " view", "viewer", "read-write", ""]) {
      expect(
        parseShareSelectorJson(JSON.stringify({ paths: ["docs"], versionId: null, access })),
        access,
      ).toBeNull();
    }
    for (const access of ["view", "comment", "edit"] as const) {
      expect(
        parseShareSelectorJson(JSON.stringify({ paths: ["docs"], versionId: null, access })),
      ).toEqual({ paths: ["docs"], versionId: null, access });
    }
  });
});

describe("share op filter", () => {
  it("allows main-version moments inside the selector, exact and prefix", () => {
    const exact = filterOpForShare(
      { paths: ["docs/a.md"], versionId: null, access: "view" },
      "moment.append",
      momentPayload(),
    );
    expect(exact.allowed).toBe(true);
    const prefix = filterOpForShare(pathShare, "moment.append", momentPayload());
    expect(prefix.allowed).toBe(true);
    if (prefix.allowed) {
      expect(prefix.blobSha256s).toEqual(["a".repeat(64)]);
    }
  });

  it("serves a MINIMAL moment.append payload with no author, summary, ids, or lineage", () => {
    const decision = filterOpForShare(
      pathShare,
      "moment.append",
      momentPayload({
        momentId: "LEAK-moment-id",
        objectId: "LEAK-object-id",
        conflictId: "LEAK-conflict-id",
        conflictEffectIndex: 0,
        recordedAtMs: 1234567,
        payloadBeforePath: "docs/a.md",
        payloadBeforeBlobSha256: "b".repeat(64),
        beforePath: "docs/a.md",
        beforeBlobSha256: "b".repeat(64),
        beforeLatestMomentId: "LEAK-latest-moment",
        beforeObjectId: "LEAK-before-object",
        metadata: {
          origin: "user",
          summary: "LEAK-summary about a private thing",
          correlationId: "LEAK-correlation-id",
          author: "LEAK-author",
        },
        author: { kind: "agent", agentRunId: "LEAK-agent-run-id", displayName: "LEAK-agent" },
      }),
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    const serialized = JSON.stringify(decision.payload);
    for (const leak of [
      "LEAK-moment-id",
      "LEAK-object-id",
      "LEAK-conflict-id",
      "LEAK-summary",
      "LEAK-correlation-id",
      "LEAK-author",
      "LEAK-agent-run-id",
      "LEAK-latest-moment",
      "LEAK-before-object",
    ]) {
      expect(serialized, leak).not.toContain(leak);
    }
    // The author is neutralized to a plain sync origin, and only replay
    // fields survive.
    expect(decision.payload).toEqual({
      operation: "write",
      // Kept on purpose: the recipient's share boundary version-checks an
      // inbound moment against the grant, and refuses one that carries no
      // version identity.
      versionId: "main",
      metadata: { origin: "sync" },
      path: "docs/a.md",
      payloadAfterPath: "docs/a.md",
      payloadBeforePath: "docs/a.md",
      payloadAfterBlobSha256: "a".repeat(64),
    });
    // Only the after-blob is reachable; the before-blob hash is not served.
    expect(decision.blobSha256s).toEqual(["a".repeat(64)]);
  });

  it("serves a MINIMAL version.create payload with redacted, metadata-free snapshots", () => {
    const selector: ShareSelector = { paths: ["docs"], versionId: "version-1", access: "view" };
    const decision = filterOpForShare(
      selector,
      "version.create",
      JSON.stringify({
        versionId: "version-1",
        name: "LEAK-version-name",
        kind: "named",
        createdAtMs: 7,
        parentVersionId: "LEAK-parent",
        forkSnapshots: [
          {
            path: "docs/a.md",
            blobSha256: "a".repeat(64),
            updatedAtMs: 9,
            latestMomentId: "LEAK-latest",
            objectId: "LEAK-object",
            metadata: { summary: "LEAK-snap-summary" },
          },
        ],
      }),
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.payload).toEqual({
      versionId: "version-1",
      forkSnapshots: [{ path: "docs/a.md", blobSha256: "a".repeat(64) }],
    });
    const serialized = JSON.stringify(decision.payload);
    for (const leak of [
      "LEAK-version-name",
      "LEAK-parent",
      "LEAK-latest",
      "LEAK-object",
      "LEAK-snap-summary",
    ]) {
      expect(serialized, leak).not.toContain(leak);
    }
  });

  // The recipient re-runs the SAME equality this filter runs
  // (`crates/dohc-engine-sync/src/share.rs`, `enforce_share_view_boundary`),
  // which it can only do when the served moment says which version it is on.
  it("serves the granted version on every moment, for a main share and a version share", () => {
    const main = filterOpForShare(pathShare, "moment.append", momentPayload());
    expect(main.allowed).toBe(true);
    if (main.allowed) {
      expect(
        (main.payload as { versionId?: unknown }).versionId,
        "MUTATION: a served moment with no version identity leaves the recipient unable to version-check it",
      ).toBe("main");
    }
    const versioned = filterOpForShare(
      { paths: ["docs"], versionId: "version-1", access: "view" },
      "moment.append",
      momentPayload({ versionId: "version-1" }),
    );
    expect(versioned.allowed).toBe(true);
    if (versioned.allowed) {
      expect((versioned.payload as { versionId?: unknown }).versionId).toBe("version-1");
    }
  });

  it("denies moments outside the selector, on prefix look-alikes, and on other versions", () => {
    expect(
      filterOpForShare(pathShare, "moment.append", momentPayload({ path: "src/app.ts", payloadAfterPath: "src/app.ts" }))
        .allowed,
    ).toBe(false);
    // "docs-private" must NOT match the "docs" folder selector.
    expect(
      filterOpForShare(
        pathShare,
        "moment.append",
        momentPayload({ path: "docs-private/x.md", payloadAfterPath: "docs-private/x.md" }),
      ).allowed,
    ).toBe(false);
    expect(
      filterOpForShare(pathShare, "moment.append", momentPayload({ versionId: "version-2" })).allowed,
    ).toBe(false);
  });

  it("denies a moment when ANY referenced path is outside the selector (boundary-crossing rename)", () => {
    const rename = momentPayload({
      operation: "rename",
      path: "docs/a.md",
      payloadBeforePath: "private/a.md",
      payloadAfterPath: "docs/a.md",
      beforePath: "private/a.md",
    });
    expect(filterOpForShare(pathShare, "moment.append", rename).allowed).toBe(false);
  });

  it("defensively denies secret-classified paths even when a selector somehow contains them", () => {
    const poisoned: ShareSelector = { paths: [".env"], versionId: null, access: "view" };
    const op = momentPayload({ path: ".env", payloadAfterPath: ".env" });
    expect(filterOpForShare(poisoned, "moment.append", op).allowed).toBe(false);
    // And a versionful share of "everything" still excludes secret paths.
    const versionShare: ShareSelector = { paths: [], versionId: "main", access: "view" };
    expect(filterOpForShare(versionShare, "moment.append", op).allowed).toBe(false);
  });

  it("denies every secret, chat, and conflict op kind outright", () => {
    for (const opKind of [
      "secret.file.put",
      "secret.file.delete",
      "secret.version.fork",
      "chat.channel.create",
      "chat.thread.create",
      "chat.thread.update",
      "chat.message.append",
      "chat.decision.set",
      "chat.attachment.add",
      "chat.reaction.set",
      "conflict.open",
      "conflict.resolve",
      "version.rename",
      "made.up.kind",
    ]) {
      const decision = filterOpForShare(
        pathShare,
        opKind,
        JSON.stringify({ path: "docs/a.md", versionId: "main", ciphertextSha256: "b".repeat(64) }),
      );
      expect(decision.allowed, opKind).toBe(false);
    }
  });

  it("never exposes conflict.resolve nested effects or successor roots to path shares", () => {
    const privateSha = "e".repeat(64);
    const successorSha = "f".repeat(64);
    const payload = JSON.stringify({
      formatVersion: 1,
      workspaceId: "workspace-a",
      conflictId: "conflict-1",
      status: "resolved",
      chosenFrom: "incoming",
      resolution: "applied-incoming",
      updatedAtMs: 2,
      targetVersionId: "main",
      sourceVersionId: "main",
      path: "docs/a.md",
      current: {},
      incoming: {},
      result: {},
      effects: [
        {
          opKind: "moment.append",
          payload: {
            versionId: "main",
            path: "private/hidden.md",
            payloadAfterPath: "private/hidden.md",
            payloadAfterBlobSha256: privateSha,
          },
        },
      ],
      lineageTransition: {
        successor: {
          updateBlobSha256: successorSha,
          stateVectorBlobSha256: privateSha,
        },
      },
    });
    const versionShare: ShareSelector = { paths: [], versionId: "main", access: "view" };

    for (const selector of [pathShare, versionShare]) {
      const decision = filterOpForShare(selector, "conflict.resolve", payload);
      expect(decision).toEqual({ allowed: false });
      expect(JSON.stringify(decision)).not.toContain("private/hidden.md");
      expect(JSON.stringify(decision)).not.toContain(privateSha);
      expect(JSON.stringify(decision)).not.toContain(successorSha);
    }
  });

  it("redacts version.create fork snapshots to the selector and drops the rest", () => {
    const selector: ShareSelector = { paths: ["docs"], versionId: "version-1", access: "view" };
    const payload = JSON.stringify({
      versionId: "version-1",
      name: "review",
      kind: "named",
      createdAtMs: 1,
      forkSnapshots: [
        { path: "docs/a.md", blobSha256: "a".repeat(64), updatedAtMs: 1, latestMomentId: "m1", metadata: {}, objectId: "o1" },
        { path: "private/leak.md", blobSha256: "c".repeat(64), updatedAtMs: 1, latestMomentId: "m2", metadata: {}, objectId: "o2" },
        { path: ".env", blobSha256: "d".repeat(64), updatedAtMs: 1, latestMomentId: "m3", metadata: {}, objectId: "o3" },
      ],
    });
    const decision = filterOpForShare(selector, "version.create", payload);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    const redacted = decision.payload as { forkSnapshots: Array<{ path: string }> };
    expect(redacted.forkSnapshots.map((snapshot) => snapshot.path)).toEqual(["docs/a.md"]);
    expect(decision.blobSha256s).toEqual(["a".repeat(64)]);
    expect(JSON.stringify(decision.payload)).not.toContain("private/leak.md");
    expect(JSON.stringify(decision.payload)).not.toContain("c".repeat(64));
  });

  it("denies version.create for path-only shares and for other versions", () => {
    const payload = JSON.stringify({ versionId: "version-1", forkSnapshots: [] });
    expect(filterOpForShare(pathShare, "version.create", payload).allowed).toBe(false);
    expect(
      filterOpForShare({ paths: [], versionId: "version-2", access: "view" }, "version.create", payload).allowed,
    ).toBe(false);
  });

  it("allows the payload-free workspace.init bootstrap op and fails closed on garbage payloads", () => {
    expect(filterOpForShare(pathShare, "workspace.init", "{}")).toEqual({
      allowed: true,
      payload: {},
      blobSha256s: [],
    });
    expect(filterOpForShare(pathShare, "moment.append", "not json").allowed).toBe(false);
    expect(filterOpForShare(pathShare, "moment.append", '"string"').allowed).toBe(false);
    expect(filterOpForShare(pathShare, "moment.append", "{}").allowed).toBe(false);
  });

  it("denies traversal disguises inside op payload paths", () => {
    for (const path of ["../outside.md", "docs/../../etc/passwd", "docs/%2e%2e/secret.md"]) {
      const op = momentPayload({ path, payloadAfterPath: path });
      expect(filterOpForShare(pathShare, "moment.append", op).allowed, path).toBe(false);
    }
  });
});

// MU-C4 shared channels: the chat-channel selector + the chat branch of the
// fail-closed filter.
describe("chat-channel share selector", () => {
  it("validates channelWireId + access and defaults to read-write", () => {
    expect(validateChatChannelShareSelector({ channelWireId: "wire-1" })).toEqual({
      ok: true,
      selector: { kind: "chat-channel", channelWireId: "wire-1", access: "read-write" },
    });
    expect(
      validateChatChannelShareSelector({ channelWireId: "wire-1", access: "read-only" }),
    ).toMatchObject({ ok: true, selector: { access: "read-only" } });
    for (const bad of [undefined, "", "  padded ", 42, "x".repeat(MAX_CHANNEL_WIRE_ID_CHARS + 1)]) {
      expect(validateChatChannelShareSelector({ channelWireId: bad }).ok, String(bad)).toBe(false);
    }
    expect(
      validateChatChannelShareSelector({ channelWireId: "wire-1", access: "write" }),
    ).toMatchObject({ ok: false, code: "invalid_access" });
  });

  it("round-trips through selector JSON and fails closed on tampered rows", () => {
    const validated = validateChatChannelShareSelector({ channelWireId: "wire-1" });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const json = JSON.stringify(validated.selector);
    expect(parseAnyShareSelectorJson(json)).toEqual(validated.selector);
    // A hand-edited row with a bad access or wire id parses to null (the
    // routes answer null with the generic 404).
    expect(parseAnyShareSelectorJson('{"kind":"chat-channel","channelWireId":""}')).toBeNull();
    expect(
      parseAnyShareSelectorJson('{"kind":"chat-channel","channelWireId":"w","access":"all"}'),
    ).toBeNull();
    // A stored row MISSING an explicit access fails closed on reload — the
    // create-time default must not resurrect a tampered/legacy row into a
    // read-write grant.
    expect(
      parseAnyShareSelectorJson('{"kind":"chat-channel","channelWireId":"w"}'),
    ).toBeNull();
    // …but an explicit access still round-trips.
    expect(
      parseAnyShareSelectorJson('{"kind":"chat-channel","channelWireId":"w","access":"read-write"}'),
    ).toEqual({ kind: "chat-channel", channelWireId: "w", access: "read-write" });
    // Path selectors still parse through the union parser, and the same
    // fail-closed-on-missing-access rule applies to them (decision G).
    expect(
      parseAnyShareSelectorJson('{"paths":["docs"],"versionId":null}'),
      "MUTATION: a path row with no access must not silently become view",
    ).toBeNull();
    expect(
      parseAnyShareSelectorJson('{"paths":["docs"],"versionId":null,"access":"view"}'),
    ).toEqual({
      paths: ["docs"],
      versionId: null,
      access: "view",
    });
  });

  it("rejects an agent wire id when trusted owner-log kind resolution is available", () => {
    const kindResolver: Pick<ChatShareThreadResolver, "channelKind"> = {
      channelKind: (wireId) => (wireId === "wire-agent" ? "agent" : undefined),
    };
    expect(
      validateChatChannelShareSelector({ channelWireId: "wire-agent" }, kindResolver),
    ).toMatchObject({ ok: false, code: "invalid_channel" });
    // Unknown/pre-provisioned wires retain the existing grant-before-sync flow;
    // the durable filter serves nothing until their human kind resolves.
    expect(
      validateChatChannelShareSelector({ channelWireId: "wire-pending" }, kindResolver),
    ).toMatchObject({ ok: true });
    expect(
      validateChatChannelShareSelector(
        { channelWireId: "wire-malformed" },
        { channelKind: () => null },
      ),
    ).toMatchObject({ ok: false, code: "invalid_channel" });
  });
});

describe("presence topic gate (MU-C1 x MU-C4)", () => {
  const channelShare: ChatChannelShareSelector = {
    kind: "chat-channel",
    channelWireId: "wire-1",
    access: "read-write",
  };
  const pathShare: ShareSelector = { paths: ["docs"], versionId: null, access: "view" };
  const threadResolver: ChatShareThreadResolver = {
    channelKind: (wireId) =>
      wireId === "wire-1" || wireId === "wire-2" ? "channel" : undefined,
    threadChannelWireId: (threadId) =>
      threadId === "thread-in" ? "wire-1" : threadId === "thread-out" ? "wire-2" : undefined,
  };

  it("scopes a chat-channel member's presence to exactly the granted wire id", () => {
    // The one allowed topic is the granted channel's wire id: a member joins
    // co-presence for that channel and nothing else.
    expect(presenceTopicAllowedForShare(channelShare, "wire-1", threadResolver)).toBe(true);
    // Another channel, a file path, or an empty topic are all refused — a
    // chat-channel grant exposes no path-based (doc) presence at all.
    for (const topic of ["wire-2", "docs/a.md", "docs", ""]) {
      expect(presenceTopicAllowedForShare(channelShare, topic, threadResolver), topic).toBe(false);
    }
    expect(presenceTopicAllowedForShare(channelShare, "wire-1")).toBe(false);
  });

  it("keeps path shares gated to their visible paths and never to a wire id", () => {
    expect(presenceTopicAllowedForShare(pathShare, "docs/a.md")).toBe(true);
    expect(presenceTopicAllowedForShare(pathShare, "wire-1")).toBe(false);
    expect(presenceTopicAllowedForShare(pathShare, "secrets/b.md")).toBe(false);
  });

  // MU-C6 thread presence: a chat-channel grant also admits `chat:thread:<tid>`
  // — but ONLY for a thread that binds to the granted channel via the same
  // forge-resistant earliest-binding resolver the durable chat filter uses.
  it("admits a thread topic bound to the granted channel", () => {
    expect(
      presenceTopicAllowedForShare(channelShare, "chat:thread:thread-in", threadResolver),
    ).toBe(true);
  });

  it("denies a thread topic bound to a DIFFERENT channel", () => {
    expect(
      presenceTopicAllowedForShare(channelShare, "chat:thread:thread-out", threadResolver),
    ).toBe(false);
  });

  it("denies an unbound/unknown thread topic", () => {
    expect(
      presenceTopicAllowedForShare(channelShare, "chat:thread:thread-unknown", threadResolver),
    ).toBe(false);
  });

  it("denies a thread topic when no resolver is wired (fail closed)", () => {
    expect(presenceTopicAllowedForShare(channelShare, "chat:thread:thread-in")).toBe(false);
  });

  it("denies a malformed chat:thread: topic", () => {
    for (const topic of ["chat:thread:", "chat:thread", "chat:thread:thread in"]) {
      expect(
        presenceTopicAllowedForShare(channelShare, topic, threadResolver),
        topic,
      ).toBe(false);
    }
  });

  it("still admits the bare granted wire id (no regression) and a path share ignores threads", () => {
    expect(presenceTopicAllowedForShare(channelShare, "wire-1", threadResolver)).toBe(true);
    // A path share never gains thread presence, resolver or not.
    expect(
      presenceTopicAllowedForShare(pathShare, "chat:thread:thread-in", threadResolver),
    ).toBe(false);
  });

  // Ordering-collision guard: a chat:thread:-shaped topic must ALWAYS resolve
  // via the resolver — bare-wireId equality must never admit it, even when the
  // grant's channelWireId is itself a chat:thread:<id> string. Otherwise a
  // crafted grant could smuggle presence for a foreign thread through the bare
  // branch.
  it("routes a thread-shaped topic through the resolver even when channelWireId equals it (no bare-equality bypass)", () => {
    const forged: ChatChannelShareSelector = {
      kind: "chat-channel",
      channelWireId: "chat:thread:thread-foreign",
      access: "read-write",
    };
    const topic = "chat:thread:thread-foreign";
    // Bare equality (topic === channelWireId) would have admitted this thread
    // topic with NO binding check. It must go through the resolver instead —
    // and an unbound thread is denied.
    expect(presenceTopicAllowedForShare(forged, topic, threadResolver)).toBe(false);
    // No resolver => a thread-shaped topic can never be authorized (fail
    // closed), even against a chat:thread:<id> channelWireId.
    expect(presenceTopicAllowedForShare(forged, topic)).toBe(false);
    // Only a GENUINE earliest binding to this selector's channelWireId admits
    // it — proving the resolver, not bare equality, is the sole authority.
    const boundResolver: ChatShareThreadResolver = {
      channelKind: (wireId) =>
        wireId === "chat:thread:thread-foreign" ? "channel" : undefined,
      threadChannelWireId: (tid) =>
        tid === "thread-foreign" ? "chat:thread:thread-foreign" : undefined,
    };
    expect(presenceTopicAllowedForShare(forged, topic, boundResolver)).toBe(true);
  });

  it("denies channel and thread presence for an agent channel despite a matching grant", () => {
    const agentShare: ChatChannelShareSelector = {
      kind: "chat-channel",
      channelWireId: "wire-agent",
      access: "read-write",
    };
    const agentResolver: ChatShareThreadResolver = {
      channelKind: (wireId) => (wireId === "wire-agent" ? "agent" : undefined),
      threadChannelWireId: (threadId) =>
        threadId === "thread-agent" ? "wire-agent" : undefined,
    };
    expect(presenceTopicAllowedForShare(agentShare, "wire-agent", agentResolver)).toBe(false);
    expect(
      presenceTopicAllowedForShare(agentShare, "chat:thread:thread-agent", agentResolver),
    ).toBe(false);
    // Presence uses one workspace topic namespace. A path selector whose path
    // collides byte-for-byte with an agent wire/thread must not bypass the chat
    // kind gate.
    expect(
      presenceTopicAllowedForShare(
        { paths: ["wire-agent"], versionId: null, access: "view" },
        "wire-agent",
        agentResolver,
      ),
    ).toBe(false);
    expect(
      presenceTopicAllowedForShare(
        { paths: ["chat:thread:thread-agent"], versionId: null, access: "view" },
        "chat:thread:thread-agent",
        agentResolver,
      ),
    ).toBe(false);
  });
});

describe("parseChatThreadTopic", () => {
  it("extracts the threadId from a well-formed thread topic", () => {
    expect(parseChatThreadTopic("chat:thread:t-123")).toBe("t-123");
    // The threadId stays opaque — only the exact prefix is consumed, so a
    // threadId containing colons is returned verbatim for the resolver to judge.
    expect(parseChatThreadTopic("chat:thread:a:b")).toBe("a:b");
  });

  it("returns null for a non-thread or malformed topic", () => {
    // No prefix, empty tail, or a tail carrying the scope-key NUL separator.
    for (const topic of ["wire-1", "docs/a.md", "chat:thread:", "chat:thread", "", "chat:thread:a\u0000b"]) {
      expect(parseChatThreadTopic(topic), topic).toBeNull();
    }
  });
});

describe("chat-channel share op filter", () => {
  const channelShare: ChatChannelShareSelector = {
    kind: "chat-channel",
    channelWireId: "wire-shared",
    access: "read-write",
  };
  // The earliest-binding truth used by these tests: thread-in binds to the
  // shared channel, thread-out binds to a DIFFERENT channel, anything else is
  // unknown (fail-closed).
  const resolver: ChatShareThreadResolver = {
    channelKind: (wireId) =>
      wireId === "wire-shared" || wireId === "wire-private" ? "channel" : undefined,
    threadChannelWireId: (threadId) =>
      threadId === "thread-in"
        ? "wire-shared"
        : threadId === "thread-out"
          ? "wire-private"
          : undefined,
  };

  function decide(opKind: string, payload: Record<string, unknown>) {
    return filterOpForShare(channelShare, opKind, JSON.stringify(payload), resolver);
  }

  it("allows exactly the granted channel's chat ops and nothing else", () => {
    expect(
      decide("chat.channel.create", { channelId: "c1", name: "team", slug: "team", kind: "channel", createdAtMs: 1, wireId: "wire-shared" }).allowed,
    ).toBe(true);
    expect(
      decide("chat.thread.create", { threadId: "thread-in", title: "", createdAtMs: 1, channelSlug: "team", channelWireId: "wire-shared" }).allowed,
    ).toBe(true);
    expect(
      decide("chat.message.append", { messageId: "m1", threadId: "thread-in", authorKind: "human", authorDisplayName: "A", body: "hi", createdAtMs: 1 }).allowed,
    ).toBe(true);
    expect(
      decide("chat.reaction.set", { reactionId: "r1", messageId: "m1", threadId: "thread-in", emoji: "👍", authorId: "u1", authorKind: "human", authorDisplayName: "A", state: "added", atMs: 1 }).allowed,
    ).toBe(true);
    // Chat ops are blob-free: no decision ever exposes a blob hash.
    const message = decide("chat.message.append", { messageId: "m1", threadId: "thread-in", authorKind: "human", authorDisplayName: "A", body: "hi", createdAtMs: 1 });
    if (message.allowed) expect(message.blobSha256s).toEqual([]);
  });

  it("serves parentMessageId on a granted-channel message", () => {
    const decision = decide("chat.message.append", {
      messageId: "m-child",
      threadId: "thread-in",
      authorKind: "human",
      authorDisplayName: "A",
      authorUserId: "u1",
      parentMessageId: "m-parent",
      body: "reply",
      createdAtMs: 2,
      internalMessageMeta: "SENTINEL-message-internal",
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.payload).toEqual({
      messageId: "m-child",
      threadId: "thread-in",
      authorKind: "human",
      authorDisplayName: "A",
      authorUserId: "u1",
      parentMessageId: "m-parent",
      body: "reply",
      createdAtMs: 2,
    });
    expect(decision.blobSha256s).toEqual([]);
  });

  it("serves a decision only for the granted thread with the exact blob-free shape", () => {
    const decision = decide("chat.decision.set", {
      threadId: "thread-in",
      messageId: "m1",
      state: "resolved",
      resolvedByMessageId: "m2",
      atMs: 3,
      internalDecisionMeta: "SENTINEL-decision-internal",
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.payload).toEqual({
      threadId: "thread-in",
      messageId: "m1",
      state: "resolved",
      resolvedByMessageId: "m2",
      atMs: 3,
    });
    expect(Object.keys(decision.payload as Record<string, unknown>)).toEqual([
      "threadId",
      "messageId",
      "state",
      "resolvedByMessageId",
      "atMs",
    ]);
    expect(decision.blobSha256s).toEqual([]);
    expect(
      decide("chat.decision.set", {
        threadId: "thread-out",
        messageId: "m-private",
        state: "resolved",
        resolvedByMessageId: "SENTINEL-private-resolution",
        atMs: 3,
      }).allowed,
    ).toBe(false);
  });

  it("serves an opaque attachment chip without objectId or pathHint", () => {
    const decision = decide("chat.attachment.add", {
      attachmentId: "attachment-1",
      threadId: "thread-in",
      messageId: "m1",
      targetKind: "file",
      objectId: "SENTINEL-private-object",
      pathHint: "private/SENTINEL-path.md",
      createdAtMs: 4,
      internalAttachmentMeta: "SENTINEL-attachment-internal",
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.payload).toEqual({
      attachmentId: "attachment-1",
      threadId: "thread-in",
      messageId: "m1",
      targetKind: "file",
      createdAtMs: 4,
    });
    expect(Object.keys(decision.payload as Record<string, unknown>)).toEqual([
      "attachmentId",
      "threadId",
      "messageId",
      "targetKind",
      "createdAtMs",
    ]);
    expect(decision.blobSha256s).toEqual([]);
    expect(JSON.stringify(decision.payload)).not.toContain("SENTINEL");
    expect(
      decide("chat.attachment.add", {
        attachmentId: "attachment-private",
        threadId: "thread-out",
        messageId: "m-private",
        targetKind: "file",
        objectId: "SENTINEL-other-object",
        pathHint: "private/SENTINEL-other-path.md",
        createdAtMs: 4,
      }).allowed,
    ).toBe(false);
  });

  it("excludes another channel's ops with sentinel content (fail-closed leak test)", () => {
    expect(
      decide("chat.channel.create", { channelId: "c2", name: "SENTINEL-private-channel", slug: "private", kind: "channel", createdAtMs: 1, wireId: "wire-private" }).allowed,
    ).toBe(false);
    expect(
      decide("chat.thread.create", { threadId: "thread-out", title: "SENTINEL-private-title", createdAtMs: 1, channelSlug: "private", channelWireId: "wire-private" }).allowed,
    ).toBe(false);
    expect(
      decide("chat.message.append", { messageId: "m2", threadId: "thread-out", authorKind: "human", authorDisplayName: "A", body: "SENTINEL-private-message", createdAtMs: 1 }).allowed,
    ).toBe(false);
    expect(
      decide("chat.reaction.set", { reactionId: "r2", messageId: "m2", threadId: "thread-out", emoji: "👍", authorId: "u1", authorKind: "human", authorDisplayName: "A", state: "added", atMs: 1 }).allowed,
    ).toBe(false);
    expect(
      decide("chat.decision.set", { threadId: "thread-out", messageId: "m2", state: "open", atMs: 1 }).allowed,
    ).toBe(false);
    expect(
      decide("chat.attachment.add", { attachmentId: "a2", threadId: "thread-out", messageId: "m2", targetKind: "file", objectId: "private", createdAtMs: 1 }).allowed,
    ).toBe(false);
    // A message on a thread the log has NO binding for is excluded too.
    expect(
      decide("chat.message.append", { messageId: "m3", threadId: "thread-unknown", authorKind: "human", authorDisplayName: "A", body: "SENTINEL-unknown", createdAtMs: 1 }).allowed,
    ).toBe(false);
  });

  it("excludes a forged thread.create that claims the granted channel for an existing foreign thread", () => {
    // The op SAYS channelWireId=wire-shared, but the log's earliest binding
    // for thread-out is wire-private — the re-bind is excluded.
    expect(
      decide("chat.thread.create", { threadId: "thread-out", title: "", createdAtMs: 1, channelSlug: "team", channelWireId: "wire-shared" }).allowed,
    ).toBe(false);
    // A thread.create claiming BOTH a channel and a linked file is malformed.
    expect(
      decide("chat.thread.create", { threadId: "thread-new", title: "", createdAtMs: 1, channelWireId: "wire-shared", linkedObjectId: "obj-1" }).allowed,
    ).toBe(false);
  });

  it("distinguishes an absent thread from an existing unshareable thread", () => {
    const unshareableResolver: ChatShareThreadResolver = {
      channelKind: (wireId) => (wireId === "wire-shared" ? "channel" : undefined),
      threadChannelWireId: (threadId) =>
        threadId === "thread-file-linked" ? null : undefined,
    };
    const payload = {
      threadId: "thread-file-linked",
      title: "",
      createdAtMs: 1,
      channelWireId: "wire-shared",
    };
    expect(
      filterOpForShare(
        channelShare,
        "chat.thread.create",
        JSON.stringify(payload),
        unshareableResolver,
      ).allowed,
    ).toBe(false);
    expect(
      filterOpForShare(
        channelShare,
        "chat.thread.create",
        JSON.stringify({ ...payload, threadId: "thread-new" }),
        unshareableResolver,
      ).allowed,
    ).toBe(true);
  });

  it("excludes every non-chat op kind from a chat-channel share (sentinels never leak)", () => {
    for (const [opKind, payload] of [
      ["workspace.init", {}],
      ["moment.append", JSON.parse(momentPayload({ path: "docs/SENTINEL-file.md" })) as Record<string, unknown>],
      ["secret.file.put", { versionId: "main", path: "notes/.env", ciphertextSha256: "b".repeat(64) }],
      ["version.create", { versionId: "main", forkSnapshots: [] }],
      ["ydoc.update", { path: "docs/a.md", updateBlobSha256: "c".repeat(64) }],
      ["conflict.open", {}],
      ["chat.thread.update", { threadId: "thread-in" }],
      ["made.up.kind", { threadId: "thread-in" }],
    ] as const) {
      const decision = filterOpForShare(channelShare, opKind, JSON.stringify(payload), resolver);
      expect(decision.allowed, opKind).toBe(false);
    }
  });

  it("fails closed without a thread resolver and on garbage payloads", () => {
    expect(
      filterOpForShare(channelShare, "chat.channel.create", JSON.stringify({ wireId: "wire-shared" })).allowed,
    ).toBe(false);
    expect(filterOpForShare(channelShare, "chat.message.append", "not json", resolver).allowed).toBe(false);
    expect(filterOpForShare(channelShare, "chat.message.append", '"str"', resolver).allowed).toBe(false);
    expect(filterOpForShare(channelShare, "chat.message.append", "{}", resolver).allowed).toBe(false);
  });

  it("denies every chat op kind on an agent channel even with a matching grant", () => {
    const agentShare: ChatChannelShareSelector = {
      kind: "chat-channel",
      channelWireId: "wire-agent",
      access: "read-write",
    };
    const agentResolver: ChatShareThreadResolver = {
      channelKind: (wireId) => (wireId === "wire-agent" ? "agent" : undefined),
      threadChannelWireId: (threadId) =>
        threadId === "thread-agent" ? "wire-agent" : undefined,
    };
    const ops: Array<readonly [string, Record<string, unknown>]> = [
      ["chat.channel.create", { wireId: "wire-agent", kind: "agent" }],
      ["chat.thread.create", { threadId: "thread-agent", channelWireId: "wire-agent" }],
      ["chat.message.append", { messageId: "m-agent", threadId: "thread-agent" }],
      ["chat.reaction.set", { reactionId: "r-agent", messageId: "m-agent", threadId: "thread-agent" }],
      ["chat.decision.set", { messageId: "m-agent", threadId: "thread-agent", state: "open", atMs: 1 }],
      ["chat.attachment.add", { attachmentId: "a-agent", messageId: "m-agent", threadId: "thread-agent", targetKind: "file", objectId: "private", createdAtMs: 1 }],
    ];
    for (const [opKind, payload] of ops) {
      expect(
        filterOpForShare(agentShare, opKind, JSON.stringify(payload), agentResolver).allowed,
        opKind,
      ).toBe(false);
    }
  });

  it("keeps chat ops excluded from path shares even when a resolver is wired", () => {
    const message = JSON.stringify({ messageId: "m1", threadId: "thread-in", authorKind: "human", authorDisplayName: "A", body: "hi", createdAtMs: 1 });
    expect(filterOpForShare(pathShare, "chat.message.append", message, resolver).allowed).toBe(false);
    // And file ops stay excluded from chat shares in the other direction —
    // the two selector kinds can never widen each other.
    expect(filterOpForShare(channelShare, "moment.append", momentPayload(), resolver).allowed).toBe(false);
  });
});
