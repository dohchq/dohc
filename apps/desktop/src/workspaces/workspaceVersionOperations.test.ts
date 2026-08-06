import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_DESKTOP_CAPTURE_TEXT_BYTES,
  RESOLVE_REQUEST_FRAME_BYTES,
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  conflictListRowForWire,
  jsonStringEncodedLength,
  settledConflictForWire,
  settledSnapshotForWire,
  type ConflictRecord,
  type JsonObject,
  type JsonValue,
  type MomentRecord,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import {
  encodedEnvelopeBytes,
  requestEnvelope,
  type EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { nativeTmpdir } from "./testTemp";
import {
  createWorkspaceEngineCapture,
  type EngineDiskWriter,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import {
  createCaptureLiveStores,
  type CaptureVersionedTextStore,
} from "./workspaceEngineCaptureLiveStore";

// PR 0M-4 named-version desktop orchestration: active-version capture routing,
// switch recovery, merge/conflict handling, restore, and scale. The stateful
// loopback uses the daemon RPC adapters and real sha256 values, but capture and
// materialization stay desktop-owned because the loopback has no filesystem
// watcher. Production daemon-owned capture and materialization run through the
// Rust and desktop end-to-end suites.

const WORKSPACE_ID = "version-ops-test";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-version-ops-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
// It reports the text each WRITE landed, so it keeps writes alone. A delete
// repeats its preimage on the after side (#487) and a binary write has no text
// there at all, so keying on `afterText` by itself would report a removed body
// as though a write had landed it.
async function readDaemonMoments(
  loopback: VersionedLoopbackEngine,
): Promise<EngineMomentRow[]> {
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

function conflictState(
  path: string,
  value: JsonValue | undefined,
): ConflictRecord["base"] {
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

// A side is present when it holds EITHER a text snapshot or a binary head.
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

  /**
   * Refuse every out-of-band body read. A resolution has COMMITTED before its
   * answer is read, so anything the desktop still has to fetch to materialize
   * is a window where the folder keeps the losing content and the conflict is
   * already closed.
   */
  failEveryBlobRead = false;

  /// Model a head that vanished between the resolve write and the desktop's
  /// read-back: a concurrent delete, or an engine that acked a write it lost.
  dropHeadAfterBinaryResolve(path: string): void {
    this.dropHeadAfter = path;
  }

  /**
   * Plant a body the desktop capture path cannot write. `versionedText.write`
   * caps a REQUEST at the in-band limit, so a large file only ever reaches the
   * store the way the daemon's own capture and a conflict resolution put it
   * there — settled inside the store, bounded by the store's text cap.
   */
  seedSettledText(workspace: string, versionId: string, path: string, text: string): void {
    this.settleTextWrite({
      id: this.internalRequestId--,
      method: VERSIONED_METHOD.textWrite,
      workspace,
      params: {
        versionId,
        path,
        text,
        objectId: `object-seeded-${path}`,
        momentId: `moment-seeded-${this.internalRequestId}`,
        origin: "local-file",
      },
    });
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
    if (this.failEveryBlobRead && request.method === VERSIONED_METHOD.textReadBlob) {
      this.requests.push(request);
      throw new Error("blob-egress-unavailable");
    }
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

      // The LEDGER holds full bodies; withholding happens at serve time
      // (`settledConflictForWire`, `conflictListRowForWire`). A withheld side
      // here would mean the fixture lost the body it is being asked to apply.
      const incomingText = existing.incoming.snapshot?.text ?? null;
      if (resolution === "apply-incoming" && incomingText === null) {
        throw new Error("state-corrupt");
      }
      const text =
        resolution === "apply-incoming"
          ? (incomingText ?? "")
          : String(local.mergedText);
      // Only a COMBINED body is bounded, and by the control frame that carried
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
          ...(typeof local.metadataSummary === "string"
            ? { summary: local.metadataSummary }
            : {}),
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
        correlationId:
          typeof params.correlationId === "string" ? params.correlationId : null,
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

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function desktopOwnedLoopbackCapture(root: string, options: {
  onError?: (context: string, error: unknown) => void;
  diskWriter?: EngineDiskWriter;
  store?: CaptureVersionedTextStore;
  rustEngineSessions?: EngineWorkspaceSessions;
} = {}): WorkspaceEngineCapture {
  const { rustEngineSessions, ...rest } = options;
  return createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    rustEngineSessions:
      rustEngineSessions ?? mockLiveSessions(new VersionedLoopbackEngine()),
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
    rustEngineSessions: mockLiveSessions(loopback, requests),
  });
}

async function versionIdByName(
  engine: WorkspaceEngineCapture,
  name: string,
): Promise<string> {
  const { versions } = await engine.listVersions();
  const version = versions.find((entry) => entry.name === name);
  if (!version) throw new Error(`No version named ${name}`);
  return version.id;
}

async function openDivergedTextConflict(incomingText: string | null = "draft\n") {
  const root = await tempRoot();
  await write(root, "plan.md", "base\n");
  const loopback = new ConflictLoopbackEngine();
  const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
  engine.start();
  await engine.flush();
  await engine.createVersion("Draft");
  if (incomingText === null) {
    await rm(join(root, "plan.md"));
    engine.captureBatch([{ path: "plan.md", operation: "delete" }]);
  } else {
    await write(root, "plan.md", incomingText);
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
  }
  await engine.flush();
  await engine.switchVersion("main");
  await write(root, "plan.md", "current\n");
  engine.captureBatch([{ path: "plan.md", operation: "update" }]);
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
  it("captures batches into the active named version, not Main", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback, requests);
    engine.start();
    await engine.flush();

    const snapshot = await engine.createVersion("Draft");
    expect(snapshot.activeVersionId).not.toBe("main");

    await write(root, "plan.md", "draft text\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.stop();

    // Positive proof of the backend, not of the outcome: a silent relapse to
    // the legacy in-process store would never open a daemon workspace, never
    // create a version over the wire, and never write text over it.
    const methods = requests.map((request) => request.method);
    expect(methods).toContain("workspace.open");
    expect(methods).toContain(VERSIONED_METHOD.versionsCreateNamed);
    expect(methods).toContain(VERSIONED_METHOD.textWrite);

    const draftWrites = (await readDaemonMoments(loopback)).filter(
      (moment) => moment.path === "plan.md" && moment.text === "draft text\n",
    );
    expect(draftWrites).toHaveLength(1);
    expect(draftWrites[0].versionId).toBe(snapshot.activeVersionId);
  });

  it("reads the active version per task, not cached across a switch", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    const created = await engine.createVersion("Draft");

    // Enqueue an edit batch and the switch back to Main without awaiting in
    // between: the batch runs first ON THE CHAIN and must land in Draft.
    await write(root, "plan.md", "draft text\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    const switched = await engine.switchVersion("main");
    await engine.stop();

    expect(switched.activeVersionId).toBe("main");
    const draftMoments = (await readDaemonMoments(loopback)).filter(
      (moment) => moment.text === "draft text\n" && moment.operation === "write",
    );
    expect(draftMoments.map((moment) => moment.versionId)).toEqual([
      created.activeVersionId,
    ]);
  });
});

describe("createVersion", () => {
  it("forks from the latest disk state and becomes active", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();

    // An edit the watcher has not settled yet must be part of the fork.
    await write(root, "plan.md", "v1 text with late edit\n");
    const snapshot = await engine.createVersion("Draft");
    await engine.stop();

    expect(snapshot.versions.map((version) => version.name).sort()).toEqual([
      "Draft",
      "Main",
    ]);
    const draft = snapshot.versions.find((version) => version.name === "Draft");
    expect(draft?.kind).toBe("named");
    expect(snapshot.activeVersionId).toBe(draft?.id);
    // The late edit was captured into Main (the fork source) first.
    const mainMoments = (await readDaemonMoments(loopback)).filter(
      (moment) => moment.versionId === "main" && moment.path === "plan.md",
    );
    expect(mainMoments.at(-1)?.text).toBe("v1 text with late edit\n");
    // Disk is untouched by create+switch.
    expect(await readText(root, "plan.md")).toBe("v1 text with late edit\n");
  });

  it("rejects duplicate names without changing the active version", async () => {
    const root = await tempRoot();
    const engine = desktopOwnedVersionLoopbackCapture(root, new VersionedLoopbackEngine());
    await engine.createVersion("Draft");
    await expect(engine.createVersion("Draft")).rejects.toMatchObject({
      code: "version-name-conflict",
    });
    const { activeVersionId, versions } = await engine.listVersions();
    expect(versions).toHaveLength(2);
    expect(activeVersionId).toBe(await versionIdByName(engine, "Draft"));
    await engine.stop();
  });
});

describe("switchVersion", () => {
  it("swaps disk content between versions and loses nothing from either side", async () => {
    const root = await tempRoot();
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
    // The switch itself captures unsettled disk edits — no captureBatch here.
    const toMain = await engine.switchVersion("main");
    expect(toMain.activeVersionId).toBe("main");
    expect(await readText(root, "plan.md")).toBe("v1 text\n");
    expect(existsSync(join(root, "draft-only.md"))).toBe(false);
    // WS-G1 behavior flip: in-cap binary files now follow the active version
    // byte-for-byte instead of being left untouched by switching.
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

  it("suppresses engine re-capture of its own switch writes via expected events", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    // Boundary signal for suppression: after the switch, processing the
    // simulated watcher event must never touch the engine store for the
    // path at all. "No new moments" alone would pass vacuously (the disk
    // content equals the engine tip, so an unsuppressed capture records
    // nothing either) — the read counter is what fails when suppression
    // breaks.
    //
    // The counted store wraps the DAEMON store, not a legacy one. Injecting a
    // store used to force the legacy engine, which made this counter and the
    // daemon mutually exclusive. Required Rust sessions now fix the engine
    // choice, so this read is a real `versionedText.read` over the wire.
    const loopback = new VersionedLoopbackEngine();
    const sessions = mockLiveSessions(loopback);
    const store = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root },
      sessions,
    ).store;
    let planReads = 0;
    const countingStore: CaptureVersionedTextStore = {
      ...store,
      async readTextFile(input) {
        if (input.path === "plan.md") planReads += 1;
        return store.readTextFile(input);
      },
    };
    const engine = desktopOwnedLoopbackCapture(root, {
      store: countingStore,
      rustEngineSessions: sessions,
    });
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft text\n");
    await engine.switchVersion("main");
    // The counter is only a suppression signal if the un-suppressed path DOES
    // read: a wrapper that never sees a read would report zero for any reason.
    expect(planReads).toBeGreaterThan(0);

    const momentsBefore = (await readDaemonMoments(loopback)).length;
    planReads = 0;
    // Simulate the watcher observing the switch's disk writes: the expected
    // event registrations must swallow them — zero new engine moments AND
    // zero engine reads for the suppressed path.
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.stop();
    expect(planReads).toBe(0);
    expect(await readDaemonMoments(loopback)).toHaveLength(momentsBefore);
    expect(
      sha256Utf8(await readText(root, "plan.md")),
    ).toBe(sha256Utf8("v1 text\n"));
  });

  it("is a no-op when switching to the already-active version", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();
    const before = (await readDaemonMoments(loopback)).length;
    // Without this the length claim below is 0 === 0, which a starved store
    // would also satisfy.
    expect(before).toBeGreaterThan(0);
    const result = await engine.switchVersion("main");
    expect(result).toEqual({ activeVersionId: "main", changedFileCount: 0 });
    expect(await readDaemonMoments(loopback)).toHaveLength(before);
    await engine.stop();
  });

  it("fails closed on an unknown version id without touching disk or active version", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const engine = desktopOwnedVersionLoopbackCapture(root, new VersionedLoopbackEngine());
    engine.start();
    await engine.flush();
    await expect(engine.switchVersion("no-such-version")).rejects.toMatchObject({
      code: "version-not-found",
    });
    expect(await readText(root, "plan.md")).toBe("v1 text\n");
    expect((await engine.listVersions()).activeVersionId).toBe("main");
    await engine.stop();
  });

  it("recovers honestly from a mid-switch disk failure", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "main a\n");
    await write(root, "b.md", "main b\n");
    const failures: string[] = [];
    let failOn: string | null = null;
    const diskWriter: EngineDiskWriter = {
      async writeTextFile(absolutePath, text) {
        if (failOn && absolutePath.endsWith(failOn)) {
          throw new Error("injected disk failure");
        }
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, text, "utf8");
      },
      async writeBinaryFile(absolutePath, bytes) {
        if (failOn && absolutePath.endsWith(failOn)) {
          throw new Error("injected disk failure");
        }
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, bytes);
      },
      async deletePath(absolutePath) {
        await rm(absolutePath, { force: true });
      },
    };
    const loopback = new VersionedLoopbackEngine();
    const engine = desktopOwnedLoopbackCapture(root, {
      diskWriter,
      rustEngineSessions: mockLiveSessions(loopback),
      onError: (context) => {
        failures.push(context);
      },
    });
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "a.md", "draft a\n");
    await write(root, "b.md", "draft b\n");
    engine.captureBatch([
      { path: "a.md", operation: "update" },
      { path: "b.md", operation: "update" },
    ]);
    await engine.flush();

    // Fail the second file's write while switching back to Main.
    failOn = "b.md";
    await expect(engine.switchVersion("main")).rejects.toThrow(
      /Could not update b\.md/,
    );
    await engine.flush();

    // The crash-honest invariant: Main is recorded active, and Main's engine
    // tip mirrors the ACTUAL (partial) disk state — a.md switched, b.md not.
    const { activeVersionId } = await engine.listVersions();
    expect(activeVersionId).toBe("main");
    expect(await readText(root, "a.md")).toBe("main a\n");
    expect(await readText(root, "b.md")).toBe("draft b\n");
    const mainTipForB = (await readDaemonMoments(loopback))
      .filter((moment) => moment.versionId === "main" && moment.path === "b.md")
      .at(-1);
    expect(mainTipForB?.text).toBe("draft b\n");

    // Nothing was lost: Draft still holds both edits, and switching remains
    // functional once the disk recovers.
    failOn = null;
    const draftId = await versionIdByName(engine, "Draft");
    await engine.switchVersion(draftId);
    expect(await readText(root, "a.md")).toBe("draft a\n");
    expect(await readText(root, "b.md")).toBe("draft b\n");
    // The interrupted switch honestly recorded the partial disk state as
    // Main's new tip (b.md = "draft b"), so switching back shows that tip —
    // while the pre-failure content stays recoverable in Main's history.
    await engine.switchVersion("main");
    expect(await readText(root, "a.md")).toBe("main a\n");
    expect(await readText(root, "b.md")).toBe("draft b\n");
    expect(
      (await readDaemonMoments(loopback)).some(
        (moment) =>
          moment.versionId === "main" &&
          moment.path === "b.md" &&
          moment.text === "main b\n",
      ),
    ).toBe(true);
    await engine.stop();
  });
});

describe("compareVersions", () => {
  it("includes unsettled on-disk edits and reports statuses", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    await write(root, "keep.md", "same\n");
    const engine = desktopOwnedVersionLoopbackCapture(root, new VersionedLoopbackEngine());
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    // Unsettled disk edits — compare must still see them.
    await write(root, "plan.md", "draft text\n");
    await write(root, "added.md", "new in draft\n");

    const draftId = await versionIdByName(engine, "Draft");
    const changes = await engine.compareVersions(draftId);
    expect(changes).toEqual({
      files: [
        { path: "added.md", status: "added", incomingText: "new in draft\n" },
        {
          path: "plan.md",
          status: "modified",
          currentText: "v1 text\n",
          incomingText: "draft text\n",
        },
      ],
      nextAfterPath: null,
    });

    await engine.switchVersion("main");
    const noChanges = await engine.compareVersions("main");
    expect(noChanges).toEqual({ files: [], nextAfterPath: null });
    await engine.stop();
  });
});

describe("mergeVersionIntoMain", () => {
  it("merges a clean version into Main and materializes when Main is active", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "v1 text\n");
    const loopback = new ConflictLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft text\n");
    await engine.switchVersion("main");
    expect(await readText(root, "plan.md")).toBe("v1 text\n");

    const draftId = await versionIdByName(engine, "Draft");
    const result = await engine.mergeVersionIntoMain(draftId);
    expect(result.conflictCount).toBe(0);
    expect(result.mergedFileCount).toBe(1);
    // Main is active: the merged content lands on disk.
    expect(await readText(root, "plan.md")).toBe("draft text\n");

    // The merge's own disk write must not re-capture.
    const momentsBefore = (await readDaemonMoments(loopback)).length;
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.stop();
    expect(await readDaemonMoments(loopback)).toHaveLength(momentsBefore);
  });

  it("does not touch the disk when a named version is active", async () => {
    const root = await tempRoot();
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
    // Disk still shows the ACTIVE version (Other), not Main's merged state.
    expect(await readText(root, "plan.md")).toBe("other text\n");
    // ...but Main's engine state has the merge.
    const moments = await readDaemonMoments(loopback);
    const mainTip = moments
      .filter((moment) => moment.versionId === "main" && moment.path === "plan.md")
      .at(-1);
    expect(mainTip?.text).toBe("draft text\n");
    // Data durability: the merge captured Other's UNSETTLED edit into
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

  it("records a conflict preserving both sides when both versions changed", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "base line\n");
    const engine = desktopOwnedVersionLoopbackCapture(root, new ConflictLoopbackEngine());
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft line\n");
    await engine.switchVersion("main");
    await write(root, "plan.md", "main line\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.flush();

    const draftId = await versionIdByName(engine, "Draft");
    const result = await engine.mergeVersionIntoMain(draftId);
    expect(result.mergedFileCount).toBe(0);
    expect(result.conflictCount).toBe(1);
    const open = await engine.listOpenConflictsPage();
    expect(open.conflicts).toHaveLength(1);
    expect(open.nextAfterConflictId).toBeNull();
    const conflict = open.conflicts[0];
    expect(conflict.path).toBe("plan.md");
    expect(conflict.base.text).toBe("base line\n");
    expect(conflict.current.text).toBe("main line\n");
    expect(conflict.incoming.text).toBe("draft line\n");
    // Main's disk state is untouched while the conflict is open.
    expect(await readText(root, "plan.md")).toBe("main line\n");
    await engine.stop();
  });

  it("lists a conflict whose row passes the wire frame cap with hydrated sides", async () => {
    // An ~8.4 MB incoming side pushes the serialized row past the daemon's
    // conflict row frame cap (8 MiB minus 64 KiB), so the modeled daemon
    // degrades the listing row to withheld metadata and the adapter hydrates
    // the side back through `versionedText.readBlob`. Before #537 this
    // listing refused outright, and one oversized conflict hid every open
    // conflict in the workspace.
    const incomingBody = `draft ${"x".repeat(8_400_000)}\n`;
    const root = await tempRoot();
    await write(root, "plan.md", "base line\n");
    const loopback = new ConflictLoopbackEngine();
    const requests: Request[] = [];
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback, requests);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    const draftId = await versionIdByName(engine, "Draft");
    await engine.switchVersion("main");
    await write(root, "plan.md", "current line\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.flush();
    // Settled directly in the store: the capture path caps its own writes at
    // the in-band limit, and this body has to be past the ROW cap.
    loopback.seedSettledText(WORKSPACE_ID, draftId, "plan.md", incomingBody);

    const merge = await engine.mergeVersionIntoMain(draftId);
    expect(merge.conflictCount).toBe(1);

    // Isolate the listing lane: the merge above also read this body for its
    // compare, and those reads must not vouch for this one.
    requests.length = 0;
    const open = await engine.listOpenConflictsPage();
    expect(open.conflicts).toHaveLength(1);
    const conflict = open.conflicts[0]!;
    // Every side arrives whole, whichever way it crossed.
    expect(conflict.base.text).toBe("base line\n");
    expect(conflict.current.text).toBe("current line\n");
    // MUTATION: drop the adapter's hydration branch and this text is gone.
    expect(conflict.incoming.text).toBe(incomingBody);
    // Each body crossed as a blob, not in the listing row — EVERY side, not
    // only the over-cap one, because a row crosses the cap on the sum of its
    // parts and the daemon withholds them all
    // (`withhold_all_conflict_side_texts`). MUTATION: stop degrading the row
    // in `conflictListRowForWire`, or withhold only its over-cap body there,
    // and the fixture serves in band what the daemon serves as digests.
    const hydrationReads = requests
      .filter((request) => request.method === VERSIONED_METHOD.textReadBlob)
      .map((request) => String((request.params as JsonObject).sha256));
    expect(hydrationReads).toEqual(
      expect.arrayContaining([
        sha256Utf8("base line\n"),
        sha256Utf8("current line\n"),
        sha256Utf8(incomingBody),
      ]),
    );
    await engine.stop();
  });

  it("resumes a merge without transferring conflict bodies", async () => {
    // Re-running a merge RESUMES: the walk over open conflicts keeps their
    // paths and discards everything else. Hydrating for it fetches every
    // withheld body of every open conflict just to drop it — the operation is
    // wrong, not merely expensive.
    //
    // MUTATION: drop `bodies: "withheld"` from the resume walk and the blob
    // read for this body reappears.
    const incomingBody = `draft ${"x".repeat(8_400_000)}\n`;
    const root = await tempRoot();
    await write(root, "plan.md", "base line\n");
    const loopback = new ConflictLoopbackEngine();
    const requests: Request[] = [];
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback, requests);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    const draftId = await versionIdByName(engine, "Draft");
    await engine.switchVersion("main");
    await write(root, "plan.md", "current line\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.flush();
    loopback.seedSettledText(WORKSPACE_ID, draftId, "plan.md", incomingBody);
    expect((await engine.mergeVersionIntoMain(draftId)).conflictCount).toBe(1);

    // Isolate the resume: the merge above read this body for its compare.
    requests.length = 0;
    expect((await engine.mergeVersionIntoMain(draftId)).conflictCount).toBe(1);
    expect(
      requests.filter(
        (request) => request.method === VERSIONED_METHOD.textReadBlob,
      ),
    ).toHaveLength(0);
    await engine.stop();
  });

  it("resolves conflicts by keep-current, apply-incoming, and apply-merged", async () => {
    const root = await tempRoot();
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
    engine.captureBatch([
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
    const byPath = new Map(
      mergeConflicts.map((conflict) => [conflict.path, conflict]),
    );

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
    engine.captureBatch([
      { path: "b.md", operation: "update" },
      { path: "c.md", operation: "update" },
    ]);
    await engine.stop();
    expect(await readDaemonMoments(loopback)).toHaveLength(momentsBefore);
  });

  it("fast-forwards a source-only binary asset onto disk", async () => {
    // Nothing on Main can be lost, so the user is asked nothing (#497).
    //
    // MUTATION: read the merged binary status as a delete -> the merge throws
    // on the absent preimage instead of landing the asset.
    const root = await tempRoot();
    const draftBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xbb, 0xbb]);
    await write(root, "plan.md", "v1 text\n");
    const loopback = new ConflictLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await writeBytes(root, "logo.png", draftBytes);
    engine.captureBatch([{ path: "logo.png", operation: "create" }]);
    await engine.flush();
    await engine.switchVersion("main");
    expect(existsSync(join(root, "logo.png"))).toBe(false);

    const draftId = await versionIdByName(engine, "Draft");
    const merge = await engine.mergeVersionIntoMain(draftId);
    expect(merge.conflictCount).toBe(0);
    expect(merge.mergedFileCount).toBe(1);
    // Main is active, so the merged bytes reach the folder byte-exactly.
    expect(await readBytes(root, "logo.png")).toEqual(draftBytes);
    await engine.stop();
  });

  it("mirrors a resolved binary side onto disk", async () => {
    const root = await tempRoot();
    const mainBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa]);
    const draftBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xbb, 0xbb]);
    await writeBytes(root, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    const loopback = new ConflictLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await writeBytes(root, "logo.png", draftBytes);
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();
    await engine.switchVersion("main");
    await writeBytes(root, "logo.png", mainBytes);
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
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
    // Going quiet here would leave the folder on the LOSING bytes while the
    // engine reports the conflict resolved -- divergence the user cannot see.
    //
    // MUTATION: skip the missing-head branch and return success -> this
    // resolves and the folder keeps main's bytes.
    const root = await tempRoot();
    const mainBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xee]);
    const draftBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xff]);
    await writeBytes(root, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    const loopback = new ConflictLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await writeBytes(root, "logo.png", draftBytes);
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();
    await engine.switchVersion("main");
    await writeBytes(root, "logo.png", mainBytes);
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();

    const draftId = await versionIdByName(engine, "Draft");
    await engine.mergeVersionIntoMain(draftId);
    const conflict = (await engine.listOpenConflictsPage()).conflicts[0]!;
    loopback.dropHeadAfterBinaryResolve("logo.png");

    // The message reaches the conflict panel, so it must read as user copy:
    // the file, what the folder still holds, and one instruction.
    await expect(
      engine.resolveConflict(conflict.id, { kind: "apply-incoming" }),
    ).rejects.toThrow(
      "dohc could not keep the copy you chose for logo.png. The folder still has the other copy. Open the merge again and choose once more.",
    );
    expect(await readBytes(root, "logo.png")).toEqual(mainBytes);
    await engine.stop();
  });

  it("leaves the folder alone when a binary conflict keeps the current side", async () => {
    const root = await tempRoot();
    const mainBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xcc]);
    const draftBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xdd, 0xdd]);
    await writeBytes(root, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    const loopback = new ConflictLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await writeBytes(root, "logo.png", draftBytes);
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();
    await engine.switchVersion("main");
    await writeBytes(root, "logo.png", mainBytes);
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();

    const draftId = await versionIdByName(engine, "Draft");
    await engine.mergeVersionIntoMain(draftId);
    const conflict = (await engine.listOpenConflictsPage()).conflicts[0]!;
    expect(conflict.incoming.contentKind).toBe("binary");
    const resolved = await engine.resolveConflict(conflict.id, {
      kind: "keep-current",
    });

    // Both choices cannot mirror the same side.
    expect(resolved.conflict.resolution).toBe("kept-current");
    expect(resolved.conflict.chosenFrom).toBe("current");
    expect(resolved.remaining.conflicts).toHaveLength(0);
    expect(await readBytes(root, "logo.png")).toEqual(mainBytes);
    await engine.stop();
  });

  it("applies an absent incoming side as a delete", async () => {
    const { root, loopback, engine, conflict } =
      await openDivergedTextConflict(null);

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
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.flush();

    await expect(
      engine.resolveConflict(conflict.id, { kind: "apply-incoming" }),
    ).rejects.toThrow(/conflict-stale-target/);
    expect(await readText(root, "plan.md")).toBe("newer current\n");
    expect((await engine.listOpenConflictsPage()).conflicts).toHaveLength(1);
    await engine.stop();
  });

  it("applies a combined resolution past the in-band cap and mirrors it", async () => {
    // The body the daemon accepts is bounded by the control frame, not by the
    // in-band cap on an ANSWER: past that cap the resolve result carries the
    // digest, and the desktop hydrates the body before it writes the folder.
    //
    // MUTATION: route the fixture's settled write back through the capped
    // `versionedText.write` -> this refuses. MUTATION: drop hydratedSnapshot
    // -> the mirror throws on the withheld body.
    const { root, engine, conflict, loopback } = await openDivergedTextConflict();
    // Every out-of-band read fails. A resolution that still needed one would
    // commit, throw, and leave the folder on the losing content.
    loopback.failEveryBlobRead = true;
    const combined = `combined ✓ line\n`.repeat(12_000);
    expect(Buffer.byteLength(combined, "utf8")).toBeGreaterThan(
      MAX_DESKTOP_CAPTURE_TEXT_BYTES,
    );

    const merged = await engine.resolveConflict(conflict.id, {
      kind: "apply-merged",
      text: combined,
    });

    expect(merged.conflict.resolution).toBe("applied-merged");
    expect(await readText(root, "plan.md")).toBe(combined);
    expect((await engine.listOpenConflictsPage()).conflicts).toHaveLength(0);
    // NOTHING was fetched to get here. The body the answer withheld is the
    // body this call submitted, so the write materialized from what the caller
    // already held.
    //
    // MUTATION: drop the offer, or give each hydration its own reader -> a
    // post-commit read appears, and with `failEveryBlobRead` set it takes the
    // write down with it.
    expect(
      loopback.requests.filter(
        (request) => request.method === VERSIONED_METHOD.textReadBlob,
      ),
    ).toHaveLength(0);
    await engine.stop();
  });

  it("applies a side choice past the in-band cap", async () => {
    // The daemon puts NO size check on a side choice: `conflicts.resolve`
    // sends no text for one. A fixture that capped it would refuse work the
    // daemon accepts, and no desktop test could prove this path at all.
    //
    // MUTATION: cap the fixture's side-choice write -> this refuses.
    const incoming = `draft ✓ line\n`.repeat(12_000);
    expect(Buffer.byteLength(incoming, "utf8")).toBeGreaterThan(
      MAX_DESKTOP_CAPTURE_TEXT_BYTES,
    );
    const root = await tempRoot();
    await write(root, "plan.md", "base\n");
    const loopback = new ConflictLoopbackEngine();
    const engine = desktopOwnedVersionLoopbackCapture(root, loopback);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    const draftId = await versionIdByName(engine, "Draft");
    await engine.switchVersion("main");
    await write(root, "plan.md", "current\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.flush();
    loopback.seedSettledText(WORKSPACE_ID, draftId, "plan.md", incoming);

    const merge = await engine.mergeVersionIntoMain(draftId);
    expect(merge.conflictCount).toBe(1);
    const conflictId = (await engine.listOpenConflictsPage()).conflicts[0]!.id;
    loopback.failEveryBlobRead = true;
    const applied = await engine.resolveConflict(conflictId, {
      kind: "apply-incoming",
    });

    expect(applied.conflict.resolution).toBe("applied-incoming");
    expect(await readText(root, "plan.md")).toBe(incoming);
    expect((await engine.listOpenConflictsPage()).conflicts).toHaveLength(0);
    await engine.stop();
  });

  it("applies an escape-heavy combined body the frame still carries", async () => {
    // 3 MiB of newlines is 6 MiB encoded: past half the frame, comfortably
    // inside it. Measuring the SERIALIZED envelope a second time through the
    // encoder would count every backslash again and refuse this at about
    // 2.8 MiB — a limit the daemon does not have.
    //
    // MUTATION: measure `jsonStringEncodedLength(JSON.stringify(params))` ->
    // the fixture refuses a request the daemon accepts.
    const { root, engine, conflict } = await openDivergedTextConflict();
    const combined = "\n".repeat(3 * 1024 * 1024);
    expect(jsonStringEncodedLength(combined)).toBeGreaterThan(
      RESOLVE_REQUEST_FRAME_BYTES / 2,
    );
    expect(jsonStringEncodedLength(combined)).toBeLessThan(RESOLVE_REQUEST_FRAME_BYTES);

    const merged = await engine.resolveConflict(conflict.id, {
      kind: "apply-merged",
      text: combined,
    });

    expect(merged.conflict.resolution).toBe("applied-merged");
    expect(await readText(root, "plan.md")).toBe(combined);
    await engine.stop();
  });

  it("refuses a request the shipping client refuses, at the boundary", async () => {
    // The fields `EngineClient` fills in before writing — `type`,
    // `deadlineMs`, `idempotencyKey` — are worth about sixty bytes. A fixture
    // that measured the caller-shaped request would see room inside that gap
    // and accept work the shipping client cannot send.
    //
    // The boundary body is calibrated from the request the fixture ACTUALLY
    // received, so it does not depend on this test guessing the param shape.
    //
    // MUTATION: measure `request` directly instead of the envelope it becomes
    // -> the boundary resolution is accepted and this fails.
    const { root, engine, conflict, loopback } = await openDivergedTextConflict();

    // A first, plainly over-frame attempt: refused, and it records the exact
    // request shape this path sends.
    const probeBody = "x".repeat(RESOLVE_REQUEST_FRAME_BYTES);
    await expect(
      engine.resolveConflict(conflict.id, { kind: "apply-merged", text: probeBody }),
    ).rejects.toThrow(/merged-text-exceeds-wire-limit/);
    const recorded = loopback.requests.findLast(
      (request) => request.method === "conflicts.resolve",
    );
    expect(recorded).toBeDefined();

    // Everything the envelope holds except the body itself. A plain-text body
    // encodes to its own length plus the two quotes around it.
    const overhead =
      encodedEnvelopeBytes(requestEnvelope(recorded!, recorded!.id)) -
      (probeBody.length + 2);
    const justPast = "x".repeat(RESOLVE_REQUEST_FRAME_BYTES - overhead - 2 + 1);

    await expect(
      engine.resolveConflict(conflict.id, { kind: "apply-merged", text: justPast }),
    ).rejects.toThrow(/merged-text-exceeds-wire-limit/);
    expect(await readText(root, "plan.md")).toBe("current\n");
    expect((await engine.listOpenConflictsPage()).conflicts).toHaveLength(1);
    await engine.stop();
  });

  it("keeps a conflict open when a combined body passes one control frame", async () => {
    const { root, engine, conflict } = await openDivergedTextConflict();

    await expect(
      engine.resolveConflict(conflict.id, {
        kind: "apply-merged",
        text: "x".repeat(RESOLVE_REQUEST_FRAME_BYTES),
      }),
    ).rejects.toThrow(
      new RegExp(
        `merged-text-exceeds-wire-limit:.*${RESOLVE_REQUEST_FRAME_BYTES} encoded ` +
          `bytes, observed \\d+ encoded bytes for this request`,
      ),
    );
    expect(await readText(root, "plan.md")).toBe("current\n");
    expect((await engine.listOpenConflictsPage()).conflicts).toHaveLength(1);
    await engine.stop();
  });

  it("keeps the conflict-loopback fixture ledger workspace-scoped", async () => {
    const { loopback, engine, conflict } = await openDivergedTextConflict();
    const foreign = await loopback.sendRequest({
      id: -1000,
      method: "conflicts.list",
      workspace: "other-workspace",
      params: { status: "open" },
    });

    expect((foreign.result as JsonObject).conflicts).toEqual([]);
    await expect(
      loopback.sendRequest({
        id: -1001,
        method: "conflicts.resolve",
        workspace: "other-workspace",
        params: {
          local: {
            conflictId: conflict.id,
            resolution: "keep-current",
          },
        },
      }),
    ).rejects.toThrow(/conflict-not-found/);
    expect((await engine.listOpenConflictsPage()).conflicts).toHaveLength(1);
    await engine.stop();
  });

  it("re-running a merge resumes open conflicts instead of duplicating them", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "base\n");
    const engine = desktopOwnedVersionLoopbackCapture(root, new ConflictLoopbackEngine());
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft\n");
    await engine.switchVersion("main");
    await write(root, "plan.md", "main\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.flush();

    const draftId = await versionIdByName(engine, "Draft");
    const first = await engine.mergeVersionIntoMain(draftId);
    expect(first.conflictCount).toBe(1);
    const firstOpen = (await engine.listOpenConflictsPage()).conflicts;
    expect(firstOpen).toHaveLength(1);

    // User closed the conflict panel; merging again surfaces the SAME open
    // conflict — duplicates never pile up.
    const second = await engine.mergeVersionIntoMain(draftId);
    expect(second.conflictCount).toBe(1);
    const secondOpen = (await engine.listOpenConflictsPage()).conflicts;
    expect(secondOpen).toHaveLength(1);
    expect(secondOpen[0].id).toBe(firstOpen[0].id);
    await engine.stop();
  });

  it("rejects merging Main into Main", async () => {
    const root = await tempRoot();
    const engine = desktopOwnedVersionLoopbackCapture(root, new VersionedLoopbackEngine());
    engine.start();
    await engine.flush();
    await expect(engine.mergeVersionIntoMain("main")).rejects.toThrow(
      /Only a named version/,
    );
    await engine.stop();
  });
});

describe("restoreFileToBeforeMoment", () => {
  it("restores a binary file to prior bytes byte-exactly", async () => {
    const root = await tempRoot();
    const before = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const after = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x02]);
    await writeBytes(root, "logo.png", before);
    const engine = desktopOwnedVersionLoopbackCapture(root, new VersionedLoopbackEngine());
    engine.start();
    await engine.flush();
    await writeBytes(root, "logo.png", after);
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();

    const page = await engine.listMoments({ limit: 10 });
    const update = page.moments.find(
      (moment) => moment.path === "logo.png" && moment.contentKind === "binary",
    );
    expect(update).toBeTruthy();
    const restored = await engine.restoreFileToBeforeMoment(update!.id);

    expect(restored.restored).toBe("text");
    expect(Buffer.from(await readFile(join(root, "logo.png")))).toEqual(before);
    await engine.stop();
  });
});

describe("switch scale coverage (PR 0M-4)", () => {
  it("switches a 200-file loopback fixture with 20 differing files", async () => {
    const root = await tempRoot();
    for (let index = 0; index < 200; index += 1) {
      await write(
        root,
        `corpus/dir-${index % 10}/file-${String(index).padStart(3, "0")}.md`,
        `# Doc ${index}\n\nbody ${index}\n`,
      );
    }
    const engine = desktopOwnedVersionLoopbackCapture(root, new VersionedLoopbackEngine());
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    for (let index = 0; index < 20; index += 1) {
      const file = index * 10;
      await write(
        root,
        `corpus/dir-${file % 10}/file-${String(file).padStart(3, "0")}.md`,
        `# Doc ${file}\n\nedited in draft\n`,
      );
    }
    // Settle the draft edits so the measured switch is the steady-state cost.
    engine.captureBatch(
      Array.from({ length: 20 }, (_, index) => ({
        path: `corpus/dir-${(index * 10) % 10}/file-${String(index * 10).padStart(3, "0")}.md`,
        operation: "update" as const,
      })),
    );
    await engine.flush();

    const startedAt = performance.now();
    const result = await engine.switchVersion("main");
    const elapsedMs = performance.now() - startedAt;
    expect(result.changedFileCount).toBe(20);
    await engine.stop();

    console.log(
      `[scale] loopback version-switch fixture, 200 files / 20 differing completed in ${elapsedMs.toFixed(1)}ms ` +
        `on ${cpus()[0]?.model ?? "unknown CPU"}, node ${process.version}, ${process.platform}`,
    );
  }, 120_000);
});
