import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERSIONED_METHOD,
  type ConflictRecord,
  type JsonObject,
  type JsonValue,
  type MomentRecord,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import {
  RESOLVE_REQUEST_FRAME_BYTES,
  jsonStringEncodedLength,
} from "@dohc/workspace-engine-client/limits";
import {
  VersionedLoopbackEngine,
  conflictListRowForWire,
  settledConflictForWire,
  settledSnapshotForWire,
} from "@dohc/workspace-engine-client/testing";
import {
  encodedEnvelopeBytes,
  requestEnvelope,
  type EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { mockDaemonSessions } from "../testing/liveEngineSessions";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";

import { createTestScratch } from "./testTemp";

// The person a restore names, as desktop main reads them.
const RESTORER = { kind: "human", humanId: "local-person" } as const;

// Named-version desktop orchestration: active-version capture routing,
// merge/conflict handling, restore, and scale. The stateful
// loopback uses the daemon RPC adapters and real sha256 values, but capture and
// materialization stay desktop-owned because the loopback has no filesystem
// watcher. Production daemon-owned capture and materialization run through the
// Rust and desktop end-to-end suites.

const WORKSPACE_ID = "version-ops-test";

interface EngineMomentRow {
  versionId: string;
  path: string;
  operation: string;
  text: string;
  summary: string | null;
}

let momentQueryId = 1;

// The daemon-path reader: `moments.list` over the wire, because the loopback
// behind the daemon harness keeps its state in memory. Rows come back newest
// first and are re-sorted ascending, the order a history reads in.
//
// It reports the text each write landed, so it keeps writes alone. A delete
// repeats its preimage on the after side and a binary write has no text
// there at all, so keying on `afterText` by itself would report a removed body
// as though a write had landed it.
async function readDaemonMoments(loopback: VersionedLoopbackEngine): Promise<EngineMomentRow[]> {
  // Drained rather than capped. An earlier draft asked for one large page and
  // threw on a cursor, which would have rejected a valid history the day a test
  // recorded one page more — a limit with no measurement behind it. Paging costs
  // nothing here and removes the question.
  const moments: MomentRecord[] = [];
  let beforeMomentOrder: number | null = null;
  for (;;) {
    const response = await loopback.sendRequest({
      id: momentQueryId++,
      method: VERSIONED_METHOD.momentsList,
      workspace: WORKSPACE_ID,
      params: {
        ...(beforeMomentOrder === null ? {} : { beforeMomentOrder }),
      },
    });
    const page = response.result as unknown as {
      moments: MomentRecord[];
      nextBeforeMomentOrder: number | null;
    };
    moments.push(...page.moments);
    if (page.nextBeforeMomentOrder === null) break;
    beforeMomentOrder = page.nextBeforeMomentOrder;
  }
  return moments
    .filter((moment) => moment.operation === "write" && moment.afterText !== null)
    .sort((left, right) => left.momentOrder - right.momentOrder)
    .map((moment) => ({
      versionId: moment.versionId,
      path: moment.path,
      operation: moment.operation,
      text: moment.afterText as string,
      summary: moment.metadataSummary ?? null,
    }));
}

function conflictState(path: string, value: JsonValue | undefined): ConflictRecord["base"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      path,
      contentKind: "text",
      snapshot: null,
      binarySha256: null,
      binaryByteLength: null,
      binaryObjectId: null,
      binaryLatestMomentId: null,
      metadataSummary: null,
      metadataCorrelationId: null,
    };
  }
  if (typeof value.objectId !== "string" || typeof value.latestMomentId !== "string") {
    throw new Error("conflict snapshot fixture is missing required head fields");
  }
  // A binary side carries its content address and head identity, never a text
  // snapshot -- the daemon shape `conflict_state_json` emits.
  if (value.contentKind === "binary") {
    // Coercing here would turn a missing hash into the STRING "undefined" and a
    // missing length into NaN, and the fixture would sail on describing a head
    // that cannot exist. Reject, the way the object id above does.
    if (typeof value.sha256 !== "string" || typeof value.byteLength !== "number") {
      throw new Error("binary conflict fixture is missing its content address or size");
    }
    return {
      path,
      contentKind: "binary",
      snapshot: null,
      binarySha256: value.sha256,
      binaryByteLength: value.byteLength,
      binaryObjectId: value.objectId,
      binaryLatestMomentId: value.latestMomentId,
      metadataSummary: null,
      metadataCorrelationId: null,
    };
  }
  if (typeof value.text !== "string") {
    throw new Error("conflict snapshot fixture is missing required text fields");
  }
  const snapshot = {
    ...value,
    metadataSummary: value.metadataSummary ?? null,
    metadataCorrelationId: value.metadataCorrelationId ?? null,
  } as NonNullable<ConflictRecord["base"]["snapshot"]>;
  return {
    path,
    contentKind: "text",
    snapshot,
    binarySha256: null,
    binaryByteLength: null,
    binaryObjectId: null,
    binaryLatestMomentId: null,
    metadataSummary: null,
    metadataCorrelationId: null,
  };
}

// A side is present when it holds either a text snapshot or a binary head.
// Testing only for a snapshot reads every binary side as an absent one, which
// turns "keep the other version's image" into "delete the file".
function sidePresent(side: ConflictRecord["current"]): boolean {
  return side.snapshot !== null || side.binarySha256 !== null;
}

function liveStateMatches(
  live: JsonValue,
  recorded: ConflictRecord["current"],
  targetPath: string,
): boolean {
  // A binary side is as strict as a text one: same path, same bytes, and the
  // same head identity, so a recreated same-bytes head cannot pass
  // (`live_state_matches_conflict_current` in crates/dohc-engine-domain).
  if (recorded.contentKind === "binary") {
    if (live === null || typeof live !== "object" || Array.isArray(live)) {
      return false;
    }
    return (
      live.contentKind === "binary" &&
      live.path === recorded.path &&
      live.sha256 === recorded.binarySha256 &&
      live.objectId === recorded.binaryObjectId &&
      live.latestMomentId === recorded.binaryLatestMomentId
    );
  }
  if (recorded.snapshot === null) {
    return live === null && targetPath === recorded.path;
  }
  if (live === null || typeof live !== "object" || Array.isArray(live)) {
    return false;
  }
  return (
    live.contentKind === "text" &&
    live.path === recorded.path &&
    live.objectId === recorded.snapshot.objectId &&
    live.latestMomentId === recorded.snapshot.latestMomentId &&
    live.text === recorded.snapshot.text
  );
}

// VersionedLoopbackEngine decides every merge outcome. This bridge only models
// the workspace-scoped conflict ledger that surrounds the versioned contract.
class ConflictLoopbackEngine extends VersionedLoopbackEngine {
  private readonly conflicts = new Map<string, ConflictRecord>();
  private conflictClock = 1;
  private internalRequestId = -1;

  private dropHeadAfter: string | null = null;

  /// Model a head that vanished between the resolve write and the desktop's
  /// read-back: a concurrent delete, or an engine that acked a write it lost.
  dropHeadAfterBinaryResolve(path: string): void {
    this.dropHeadAfter = path;
  }

  private conflictKey(workspace: string, conflictId: string): string {
    return `${workspace}\u0000${conflictId}`;
  }

  private requiredWorkspace(request: Request): string {
    if (typeof request.workspace !== "string" || request.workspace.length === 0) {
      throw new Error("workspace-not-open");
    }
    return request.workspace;
  }

  override async sendRequest(request: Request): Promise<Response> {
    if (request.method === "conflicts.list") {
      this.requests.push(request);
      const workspace = this.requiredWorkspace(request);
      const params = request.params as JsonObject;
      const status = params.status;
      const afterConflictId = params.afterConflictId;
      let conflicts = [...this.conflicts.values()]
        .filter(
          (conflict) =>
            conflict.workspaceId === workspace &&
            (status === undefined || conflict.status === status),
        )
        .sort((left, right) => left.id.localeCompare(right.id));
      if (typeof afterConflictId === "string") {
        const index = conflicts.findIndex((conflict) => conflict.id === afterConflictId);
        conflicts = index < 0 ? conflicts : conflicts.slice(index + 1);
      }
      // This desktop conflict ledger is intentionally single-page. Adapter paging is
      // covered in versionedLiveAdapter.test.ts; the real cursor contract is covered
      // in crates/dohc-workspace-engine/tests/rpc_conflicts.rs.
      return {
        id: request.id,
        result: {
          // The daemon degrades a row past the conflict row frame cap to
          // withheld metadata; modeling that here is what lets these tests
          // prove the adapter hydrates it back.
          conflicts: conflicts.map(
            (conflict) => conflictListRowForWire(conflict) as ConflictRecord,
          ),
          nextAfterConflictId: null,
        },
      };
    }

    if (request.method === "conflicts.resolve") {
      this.requests.push(request);
      const workspace = this.requiredWorkspace(request);
      const params = request.params as JsonObject;
      const local = params.local as JsonObject;
      const conflictId = String(local.conflictId);
      const key = this.conflictKey(workspace, conflictId);
      const existing = this.conflicts.get(key);
      if (!existing) throw new Error("conflict-not-found");
      const live = await super.sendRequest({
        id: this.internalRequestId--,
        method: VERSIONED_METHOD.textRead,
        workspace,
        params: {
          versionId: existing.targetVersionId,
          path: existing.path,
        },
      });
      if (!liveStateMatches(live.result, existing.current, existing.path)) {
        throw new Error("conflict-stale-target");
      }
      const resolution = String(local.resolution);
      const resolutionName =
        resolution === "keep-current"
          ? "kept-current"
          : resolution === "apply-incoming"
            ? "applied-incoming"
            : "applied-merged";
      const chosenFrom =
        resolution === "keep-current"
          ? "current"
          : resolution === "apply-incoming"
            ? "incoming"
            : "merged";
      const resolved: ConflictRecord = {
        ...existing,
        status: "resolved",
        chosenFrom,
        resolution: resolutionName,
        updatedAtMs: this.conflictClock++,
      };
      if (resolution === "keep-current") {
        this.conflicts.set(key, resolved);
        return {
          id: request.id,
          result: { conflict: settledConflictForWire(resolved), write: null, delete: null },
        };
      }

      if (resolution === "apply-incoming" && existing.incoming.contentKind === "binary") {
        // Binary bytes never ride in a resolve result: the daemon writes the
        // head and reports `write: null`. The desktop has to read the head
        // back to mirror it, which is the branch under test.
        const source = await super.sendRequest({
          id: this.internalRequestId--,
          method: VERSIONED_METHOD.binaryRead,
          workspace,
          params: { versionId: existing.sourceVersionId, path: existing.path },
        });
        const bytesBase64 = (source.result as JsonObject | null)?.bytesBase64;
        if (typeof bytesBase64 !== "string") {
          throw new Error(`No binary bytes for ${existing.path}.`);
        }
        await super.sendRequest({
          id: this.internalRequestId--,
          method: VERSIONED_METHOD.binaryWrite,
          workspace,
          params: {
            versionId: existing.targetVersionId,
            path: existing.path,
            bytesBase64,
            objectId: String(local.objectId),
            momentId: String(local.writeMomentId),
            origin: String(local.metadataOrigin),
          },
        });
        if (this.dropHeadAfter === existing.path) {
          this.dropHeadAfter = null;
          await super.sendRequest({
            id: this.internalRequestId--,
            method: VERSIONED_METHOD.textDelete,
            workspace,
            params: {
              versionId: existing.targetVersionId,
              path: existing.path,
              origin: String(local.metadataOrigin),
            },
          });
        }
        this.conflicts.set(key, resolved);
        return {
          id: request.id,
          result: { conflict: settledConflictForWire(resolved), write: null, delete: null },
        };
      }

      if (resolution === "apply-incoming" && !sidePresent(existing.incoming)) {
        const deletion = !sidePresent(existing.current)
          ? null
          : await super.sendRequest({
              id: this.internalRequestId--,
              idempotencyKey: String(local.deleteMomentId),
              method: VERSIONED_METHOD.textDelete,
              workspace,
              params: {
                versionId: existing.targetVersionId,
                path: existing.path,
                origin: String(local.metadataOrigin),
                ...(typeof local.metadataSummary === "string"
                  ? { summary: local.metadataSummary }
                  : {}),
                ...(typeof local.metadataCorrelationId === "string"
                  ? { correlationId: local.metadataCorrelationId }
                  : {}),
              },
            });
        this.conflicts.set(key, resolved);
        return {
          id: request.id,
          result: {
            conflict: settledConflictForWire(resolved),
            write: null,
            delete: deletion?.result ?? null,
          },
        };
      }

      // The ledger holds full bodies; withholding happens at serve time
      // (`settledConflictForWire`, `conflictListRowForWire`). A withheld side
      // here would mean the fixture lost the body it is being asked to apply.
      const incomingText = existing.incoming.snapshot?.text ?? null;
      if (resolution === "apply-incoming" && incomingText === null) {
        throw new Error("state-corrupt");
      }
      const text =
        resolution === "apply-incoming" ? (incomingText ?? "") : String(local.mergedText);
      // Only a combined body is bounded, and by the control frame that carried
      // it — the daemon puts no size check on a side choice, which sends no
      // text at all (lib.rs conflicts_resolve). What it measures is the whole
      // REQUEST: the same envelope carries two 16 KiB metadata fields and five
      // identifiers.
      //
      // The client’s own measurement, not a second model of it. Building the
      // envelope by hand here left out the nullable fields `EngineClient`
      // fills in — about sixty bytes — so at the frame boundary this fixture
      // accepted requests the shipping client refuses.
      //
      // The wire id is this request’s own: a loopback does not renumber, so
      // the envelope it would frame carries the id it received.
      const encodedRequest = encodedEnvelopeBytes(requestEnvelope(request, request.id));
      if (resolution === "apply-merged" && encodedRequest > RESOLVE_REQUEST_FRAME_BYTES) {
        throw new Error(
          `merged-text-exceeds-wire-limit: one control frame carries a resolve ` +
            `request of at most ${RESOLVE_REQUEST_FRAME_BYTES} encoded bytes, ` +
            `observed ${encodedRequest} encoded bytes for this request ` +
            `(${Buffer.byteLength(text, "utf8")} raw bytes of combined body, ` +
            `${jsonStringEncodedLength(text)} encoded)`,
        );
      }
      // The daemon settles inside the store, so `versionedText.write`'s in-band
      // request cap never bounds this body.
      const write = this.settleTextWrite({
        id: this.internalRequestId--,
        method: VERSIONED_METHOD.textWrite,
        workspace,
        params: {
          versionId: existing.targetVersionId,
          path: existing.path,
          text,
          objectId: String(local.objectId),
          momentId: String(local.writeMomentId),
          origin: String(local.metadataOrigin),
          ...(typeof local.metadataSummary === "string" ? { summary: local.metadataSummary } : {}),
          ...(typeof local.metadataCorrelationId === "string"
            ? { correlationId: local.metadataCorrelationId }
            : {}),
        },
      });
      const settled = write.result as JsonObject;
      this.conflicts.set(key, resolved);
      return {
        id: request.id,
        result: {
          conflict: settledConflictForWire(resolved),
          write: {
            ...settled,
            snapshot: settledSnapshotForWire(settled.snapshot as JsonObject),
          },
          delete: null,
        },
      };
    }

    const response = await super.sendRequest(request);
    if (request.method !== VERSIONED_METHOD.versionsMerge) return response;
    const result = response.result as JsonObject;
    if (result.status !== "conflict") return response;
    const workspace = this.requiredWorkspace(request);
    const conflictId = String(result.conflictId);
    const key = this.conflictKey(workspace, conflictId);
    if (this.conflicts.has(key)) return response;
    const params = request.params as JsonObject;
    const comparison = result.comparison as JsonObject;
    const path = String(params.path);
    const recordedAtMs = this.conflictClock++;
    this.conflicts.set(key, {
      id: conflictId,
      workspaceId: workspace,
      path,
      targetVersionId: String(params.targetVersionId),
      sourceVersionId: String(params.sourceVersionId),
      createdAtMs: recordedAtMs,
      updatedAtMs: recordedAtMs,
      status: "open",
      chosenFrom: "current",
      resolution: null,
      metadata: {
        origin: String(params.origin),
        summary: typeof params.summary === "string" ? params.summary : null,
        correlationId: typeof params.correlationId === "string" ? params.correlationId : null,
      },
      base: conflictState(path, comparison.base),
      current: conflictState(path, comparison.current),
      incoming: conflictState(path, comparison.incoming),
    });
    return response;
  }
}

async function write(root: string, path: string, contents: string) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function writeBytes(root: string, path: string, contents: Uint8Array) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function readText(root: string, path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

async function readBytes(root: string, path: string): Promise<Buffer> {
  return readFile(join(root, path));
}

function desktopOwnedLoopbackCapture(
  root: string,
  options: {
    attachmentId?: symbol;
    onError?: (context: string, error: unknown) => void;
    rustEngineSessions?: EngineWorkspaceSessions;
  } = {},
): WorkspaceEngineCapture {
  const {
    attachmentId = Symbol("test-workspace-attachment"),
    rustEngineSessions,
    ...rest
  } = options;
  return createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    attachmentId,
    rustEngineSessions:
      rustEngineSessions ??
      mockDaemonSessions({
        rootPath: root,
        workspaceId: WORKSPACE_ID,
        loopback: new VersionedLoopbackEngine(),
      }),
    ...rest,
  });
}

// The daemon-adapter loopback. `requests` proves that operations cross the wire,
// while capture and disk materialization remain desktop-owned.
function desktopOwnedVersionLoopbackCapture(
  root: string,
  loopback: VersionedLoopbackEngine,
  requests?: Request[],
): WorkspaceEngineCapture {
  return desktopOwnedLoopbackCapture(root, {
    rustEngineSessions: mockDaemonSessions({
      rootPath: root,
      workspaceId: WORKSPACE_ID,
      loopback,
      requests,
    }),
  });
}

async function versionIdByName(engine: WorkspaceEngineCapture, name: string): Promise<string> {
  const { versions } = await engine.listVersions();
  const version = versions.find((entry) => entry.name === name);
  if (!version) throw new Error(`No version named ${name}`);
  return version.id;
}

async function openDivergedTextConflict(incomingText: string | null = "draft\n") {
  const root = await createTestScratch("dohc-version-ops-");
  await write(root, "plan.md", "base\n");
  const loopback = new ConflictLoopbackEngine();
  const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
  engine.start();
  await engine.flush();
  await engine.createVersion("Draft");
  if (incomingText === null) {
    await rm(join(root, "plan.md"));
    engine.observeFileEvents([{ path: "plan.md", operation: "delete" }]);
  } else {
    await write(root, "plan.md", incomingText);
    engine.observeFileEvents([{ path: "plan.md", operation: "update" }]);
  }
  await engine.flush();
  await engine.switchVersion("main");
  await write(root, "plan.md", "current\n");
  engine.observeFileEvents([{ path: "plan.md", operation: "update" }]);
  await engine.flush();

  const draftId = await versionIdByName(engine, "Draft");
  const merge = await engine.mergeVersionIntoMain(draftId);
  if (merge.conflictCount !== 1) {
    throw new Error(`Expected one conflict, received ${merge.conflictCount}.`);
  }
  const page = await engine.listOpenConflictsPage();
  if (page.conflicts.length !== 1) {
    throw new Error(`Expected one open conflict, received ${page.conflicts.length}.`);
  }
  return { root, loopback, engine, conflict: page.conflicts[0] };
}

describe("active-version capture routing", () => {
  it("reads the active version per task, not cached across a switch", async () => {
    const root = await createTestScratch("dohc-version-ops-");
    await write(root, "plan.md", "v1 text\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    const created = await engine.createVersion("Draft");

    // Enqueue an edit batch and the switch back to Main without awaiting in
    // between: the batch runs first ON THE CHAIN and must land in Draft.
    await write(root, "plan.md", "draft text\n");
    engine.observeFileEvents([{ path: "plan.md", operation: "update" }]);
    const switched = await engine.switchVersion("main");
    await engine.stop();

    expect(switched.activeVersionId).toBe("main");
    const draftMoments = (await readDaemonMoments(loopback)).filter(
      (moment) => moment.text === "draft text\n" && moment.operation === "write",
    );
    expect(draftMoments.map((moment) => moment.versionId)).toEqual([created.activeVersionId]);
  });
});

describe("switchVersion", () => {
  it("swaps disk content between versions and loses nothing from either side", async () => {
    const root = await createTestScratch("dohc-version-ops-");
    await write(root, "plan.md", "v1 text\n");
    const logoBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    await writeBytes(root, "logo.png", logoBytes);
    const engine = desktopOwnedVersionLoopbackCapture(root, new VersionedLoopbackEngine());
    engine.start();
    await engine.flush();

    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft text\n");
    await write(root, "draft-only.md", "only in draft\n");
    const draftLogoBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x02]);
    await writeBytes(root, "logo.png", draftLogoBytes);
    // The switch itself captures unsettled disk edits — no observeFileEvents here.
    const toMain = await engine.switchVersion("main");
    expect(toMain.activeVersionId).toBe("main");
    expect(await readText(root, "plan.md")).toBe("v1 text\n");
    expect(existsSync(join(root, "draft-only.md"))).toBe(false);
    // In-cap binary files follow the active version byte-for-byte when
    // switching.
    expect(existsSync(join(root, "logo.png"))).toBe(true);
    expect(new Uint8Array(await readFile(join(root, "logo.png")))).toEqual(logoBytes);

    const draftId = await versionIdByName(engine, "Draft");
    const backToDraft = await engine.switchVersion(draftId);
    expect(backToDraft.activeVersionId).toBe(draftId);
    expect(await readText(root, "plan.md")).toBe("draft text\n");
    expect(await readText(root, "draft-only.md")).toBe("only in draft\n");
    expect(new Uint8Array(await readFile(join(root, "logo.png")))).toEqual(draftLogoBytes);
    await engine.stop();
  });
});

describe("mergeVersionIntoMain", () => {
  it("does not touch the disk when a named version is active", async () => {
    const root = await createTestScratch("dohc-version-ops-");
    await write(root, "plan.md", "v1 text\n");
    const loopback = new ConflictLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft text\n");
    // Second version to stay on while merging Draft.
    await engine.switchVersion("main");
    await engine.createVersion("Other");
    await write(root, "plan.md", "other text\n");

    const draftId = await versionIdByName(engine, "Draft");
    const result = await engine.mergeVersionIntoMain(draftId);
    expect(result.mergedFileCount).toBe(1);
    // Disk still shows the active version (Other), not Main's merged state.
    expect(await readText(root, "plan.md")).toBe("other text\n");
    // ...but Main's engine state has the merge.
    const moments = await readDaemonMoments(loopback);
    const mainTip = moments
      .filter((moment) => moment.versionId === "main" && moment.path === "plan.md")
      .at(-1);
    expect(mainTip?.text).toBe("draft text\n");
    // Data durability: the merge captured Other's unsettled edit into
    // Other's own tip first — a later switch away can't lose "other text".
    const otherId = await versionIdByName(engine, "Other");
    const otherTip = moments
      .filter((moment) => moment.versionId === otherId && moment.path === "plan.md")
      .at(-1);
    expect(otherTip?.text).toBe("other text\n");
    // Switching away and back materializes exactly that captured edit.
    await engine.switchVersion("main");
    expect(await readText(root, "plan.md")).toBe("draft text\n");
    await engine.switchVersion(otherId);
    expect(await readText(root, "plan.md")).toBe("other text\n");
    await engine.stop();
  });

  it("resolves conflicts by keep-current, apply-incoming, and apply-merged", async () => {
    const root = await createTestScratch("dohc-version-ops-");
    await write(root, "a.md", "base a\n");
    await write(root, "b.md", "base b\n");
    await write(root, "c.md", "base c\n");
    const loopback = new ConflictLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    for (const path of ["a.md", "b.md", "c.md"]) {
      await write(root, path, `draft ${path}\n`);
    }
    await engine.switchVersion("main");
    for (const path of ["a.md", "b.md", "c.md"]) {
      await write(root, path, `main ${path}\n`);
    }
    engine.observeFileEvents([
      { path: "a.md", operation: "update" },
      { path: "b.md", operation: "update" },
      { path: "c.md", operation: "update" },
    ]);
    await engine.flush();

    const draftId = await versionIdByName(engine, "Draft");
    const merge = await engine.mergeVersionIntoMain(draftId);
    expect(merge.conflictCount).toBe(3);
    const mergeConflicts = (await engine.listOpenConflictsPage()).conflicts;
    expect(mergeConflicts).toHaveLength(3);
    const byPath = new Map(mergeConflicts.map((conflict) => [conflict.path, conflict]));

    const kept = await engine.resolveConflict(byPath.get("a.md")!.id, {
      kind: "keep-current",
    });
    expect(kept.conflict.resolution).toBe("kept-current");
    expect(kept.remaining.conflicts).toHaveLength(2);
    expect(kept.remaining.nextAfterConflictId).toBeNull();
    expect(await readText(root, "a.md")).toBe("main a.md\n");

    const incoming = await engine.resolveConflict(byPath.get("b.md")!.id, {
      kind: "apply-incoming",
    });
    expect(incoming.conflict.resolution).toBe("applied-incoming");
    // Main is active: applying the incoming side updates the disk.
    expect(await readText(root, "b.md")).toBe("draft b.md\n");

    const merged = await engine.resolveConflict(byPath.get("c.md")!.id, {
      kind: "apply-merged",
      text: "combined c\n",
    });
    expect(merged.conflict.resolution).toBe("applied-merged");
    expect(merged.remaining.conflicts).toHaveLength(0);
    expect(merged.remaining.nextAfterConflictId).toBeNull();
    expect(await readText(root, "c.md")).toBe("combined c\n");
    expect((await engine.listOpenConflictsPage()).conflicts).toHaveLength(0);

    // Resolution disk writes never re-capture.
    const momentsBefore = (await readDaemonMoments(loopback)).length;
    engine.observeFileEvents([
      { path: "b.md", operation: "update" },
      { path: "c.md", operation: "update" },
    ]);
    await engine.stop();
    expect(await readDaemonMoments(loopback)).toHaveLength(momentsBefore);
  });

  it("mirrors a resolved binary side onto disk", async () => {
    const root = await createTestScratch("dohc-version-ops-");
    const mainBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa]);
    const draftBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xbb, 0xbb]);
    await writeBytes(root, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    const loopback = new ConflictLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await writeBytes(root, "logo.png", draftBytes);
    engine.observeFileEvents([{ path: "logo.png", operation: "update" }]);
    await engine.flush();
    await engine.switchVersion("main");
    await writeBytes(root, "logo.png", mainBytes);
    engine.observeFileEvents([{ path: "logo.png", operation: "update" }]);
    await engine.flush();

    const draftId = await versionIdByName(engine, "Draft");
    const merge = await engine.mergeVersionIntoMain(draftId);
    expect(merge.conflictCount).toBe(1);
    const conflict = (await engine.listOpenConflictsPage()).conflicts[0]!;
    expect(conflict.incoming.contentKind).toBe("binary");

    const resolved = await engine.resolveConflict(conflict.id, {
      kind: "apply-incoming",
    });

    // The engine reports no text write for bytes, so the folder only follows if
    // the desktop reads the resolved head back and mirrors it.
    expect(resolved.conflict.resolution).toBe("applied-incoming");
    expect(await readBytes(root, "logo.png")).toEqual(draftBytes);
    await engine.stop();
  });

  it("refuses a binary resolution whose engine head vanished", async () => {
    // Going quiet here would leave the folder on the losing bytes while the
    // engine reports the conflict resolved -- divergence the user cannot see.
    //
    const root = await createTestScratch("dohc-version-ops-");
    const mainBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xee]);
    const draftBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xff]);
    await writeBytes(root, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    const loopback = new ConflictLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await writeBytes(root, "logo.png", draftBytes);
    engine.observeFileEvents([{ path: "logo.png", operation: "update" }]);
    await engine.flush();
    await engine.switchVersion("main");
    await writeBytes(root, "logo.png", mainBytes);
    engine.observeFileEvents([{ path: "logo.png", operation: "update" }]);
    await engine.flush();

    const draftId = await versionIdByName(engine, "Draft");
    await engine.mergeVersionIntoMain(draftId);
    const conflict = (await engine.listOpenConflictsPage()).conflicts[0]!;
    loopback.dropHeadAfterBinaryResolve("logo.png");

    // The message reaches the conflict panel, so it must read as user copy:
    // the file, what the folder still holds, and one instruction.
    await expect(engine.resolveConflict(conflict.id, { kind: "apply-incoming" })).rejects.toThrow(
      "dohc could not keep the copy you chose for logo.png. The folder still has the other copy. Open the merge again and choose once more.",
    );
    expect(await readBytes(root, "logo.png")).toEqual(mainBytes);
    await engine.stop();
  });

  it("applies an absent incoming side as a delete", async () => {
    const { root, loopback, engine, conflict } = await openDivergedTextConflict(null);

    const resolved = await engine.resolveConflict(conflict.id, {
      kind: "apply-incoming",
    });

    expect(resolved.conflict.resolution).toBe("applied-incoming");
    expect(existsSync(join(root, "plan.md"))).toBe(false);
    expect(
      loopback.requests.some(
        (request) =>
          request.method === VERSIONED_METHOD.textDelete &&
          (request.params as JsonObject).path === "plan.md",
      ),
    ).toBe(true);
    await engine.stop();
  });

  it("rejects a stale target and keeps its conflict open", async () => {
    const { root, engine, conflict } = await openDivergedTextConflict();
    await write(root, "plan.md", "newer current\n");
    engine.observeFileEvents([{ path: "plan.md", operation: "update" }]);
    await engine.flush();

    await expect(engine.resolveConflict(conflict.id, { kind: "apply-incoming" })).rejects.toThrow(
      /conflict-stale-target/,
    );
    expect(await readText(root, "plan.md")).toBe("newer current\n");
    expect((await engine.listOpenConflictsPage()).conflicts).toHaveLength(1);
    await engine.stop();
  });
});

describe("restoreFileToBeforeMoment", () => {
  it("restores a binary file to prior bytes byte-exactly", async () => {
    const root = await createTestScratch("dohc-version-ops-");
    const before = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const after = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x02]);
    await writeBytes(root, "logo.png", before);
    const engine = desktopOwnedVersionLoopbackCapture(root, new VersionedLoopbackEngine());
    engine.start();
    await engine.flush();
    await writeBytes(root, "logo.png", after);
    engine.observeFileEvents([{ path: "logo.png", operation: "update" }]);
    await engine.flush();

    const page = await engine.listMoments({ limit: 10 });
    const update = page.moments.find(
      (moment) => moment.path === "logo.png" && moment.contentKind === "binary",
    );
    expect(update).toBeTruthy();
    const restored = await engine.restoreFileToBeforeMoment(update!.id, RESTORER);

    expect(restored.restored).toBe("text");
    expect(Buffer.from(await readFile(join(root, "logo.png")))).toEqual(before);
    await engine.stop();
  });
});
