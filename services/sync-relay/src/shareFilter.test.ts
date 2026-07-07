import { describe, expect, it } from "vitest";
import {
  MAX_SHARE_PATHS,
  filterOpForShare,
  parseShareSelectorJson,
  validateShareSelector,
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
