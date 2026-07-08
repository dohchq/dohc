import { describe, expect, it } from "vitest";
import {
  MAX_CHANNEL_WIRE_ID_CHARS,
  MAX_SHARE_PATHS,
  filterOpForShare,
  parseAnyShareSelectorJson,
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

const pathShare: ShareSelector = { paths: ["docs"], versionId: null };

describe("share selector validation", () => {
  it("accepts explicit tracked paths and normalizes/dedupes them", () => {
    const result = validateShareSelector({ paths: ["docs/notes.md", "docs//notes.md", "src"] });
    expect(result).toEqual({
      ok: true,
      selector: { paths: ["docs/notes.md", "src"], versionId: null },
    });
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

  it("requires at least one path or a version and caps the path count", () => {
    expect(validateShareSelector({})).toMatchObject({ ok: false, code: "empty_selector" });
    expect(validateShareSelector({ paths: [] })).toMatchObject({ ok: false, code: "empty_selector" });
    expect(
      validateShareSelector({ paths: Array.from({ length: MAX_SHARE_PATHS + 1 }, (_, i) => `f${i}.md`) }),
    ).toMatchObject({ ok: false, code: "too_many_paths" });
    expect(validateShareSelector({ versionId: "version-1" })).toMatchObject({ ok: true });
    expect(validateShareSelector({ versionId: "  padded " })).toMatchObject({
      ok: false,
      code: "invalid_version",
    });
  });

  it("round-trips through selector JSON and rejects malformed persisted selectors", () => {
    const validated = validateShareSelector({ paths: ["docs"], versionId: "v-1" });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const json = JSON.stringify(validated.selector);
    expect(parseShareSelectorJson(json)).toEqual(validated.selector);
    expect(parseShareSelectorJson("not json")).toBeNull();
    expect(parseShareSelectorJson('{"paths":"docs","versionId":null}')).toBeNull();
    expect(parseShareSelectorJson('{"paths":[1],"versionId":null}')).toBeNull();
  });
});

describe("share op filter", () => {
  it("allows main-version moments inside the selector, exact and prefix", () => {
    const exact = filterOpForShare(
      { paths: ["docs/a.md"], versionId: null },
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
    const selector: ShareSelector = { paths: ["docs"], versionId: "version-1" };
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
    const poisoned: ShareSelector = { paths: [".env"], versionId: null };
    const op = momentPayload({ path: ".env", payloadAfterPath: ".env" });
    expect(filterOpForShare(poisoned, "moment.append", op).allowed).toBe(false);
    // And a versionful share of "everything" still excludes secret paths.
    const versionShare: ShareSelector = { paths: [], versionId: "main" };
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

  it("redacts version.create fork snapshots to the selector and drops the rest", () => {
    const selector: ShareSelector = { paths: ["docs"], versionId: "version-1" };
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
      filterOpForShare({ paths: [], versionId: "version-2" }, "version.create", payload).allowed,
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
    // Legacy path selectors still parse through the union parser.
    expect(parseAnyShareSelectorJson('{"paths":["docs"],"versionId":null}')).toEqual({
      paths: ["docs"],
      versionId: null,
    });
  });
});

describe("presence topic gate (MU-C1 x MU-C4)", () => {
  const channelShare: ChatChannelShareSelector = {
    kind: "chat-channel",
    channelWireId: "wire-1",
    access: "read-write",
  };
  const pathShare: ShareSelector = { paths: ["docs"], versionId: null };

  it("scopes a chat-channel member's presence to exactly the granted wire id", () => {
    // The one allowed topic is the granted channel's wire id: a member joins
    // co-presence for that channel and nothing else.
    expect(presenceTopicAllowedForShare(channelShare, "wire-1")).toBe(true);
    // Another channel, a file path, or an empty topic are all refused — a
    // chat-channel grant exposes no path-based (doc) presence at all.
    for (const topic of ["wire-2", "docs/a.md", "docs", ""]) {
      expect(presenceTopicAllowedForShare(channelShare, topic), topic).toBe(false);
    }
  });

  it("keeps path shares gated to their visible paths and never to a wire id", () => {
    expect(presenceTopicAllowedForShare(pathShare, "docs/a.md")).toBe(true);
    expect(presenceTopicAllowedForShare(pathShare, "wire-1")).toBe(false);
    expect(presenceTopicAllowedForShare(pathShare, "secrets/b.md")).toBe(false);
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
    threadChannelWireId: (threadId) =>
      threadId === "thread-in" ? "wire-shared" : threadId === "thread-out" ? "wire-private" : null,
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

  it("keeps chat ops excluded from path shares even when a resolver is wired", () => {
    const message = JSON.stringify({ messageId: "m1", threadId: "thread-in", authorKind: "human", authorDisplayName: "A", body: "hi", createdAtMs: 1 });
    expect(filterOpForShare(pathShare, "chat.message.append", message, resolver).allowed).toBe(false);
    // And file ops stay excluded from chat shares in the other direction —
    // the two selector kinds can never widen each other.
    expect(filterOpForShare(channelShare, "moment.append", momentPayload(), resolver).allowed).toBe(false);
  });
});
