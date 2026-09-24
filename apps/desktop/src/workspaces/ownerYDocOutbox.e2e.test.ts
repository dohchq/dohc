import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import {
  OwnerYDocOutbox,
  type LiveObjectBinding,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { deferred } from "../testing/deferred";
import {
  createRealDaemonLifecycle,
  createRealDaemonWorkspaceSessions,
} from "../testing/realDaemonWorkspaceSessions";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import {
  OwnerYDocOutboxDrainer,
  type FreshOwnerAuthority,
  type OwnerYDocDelivery,
  type OwnerYDocDeliveryEnvelope,
  type OwnerYDocDeliveryResult,
} from "./ownerYDocOutbox";
import { createTestScratch } from "./testTemp";

const engine = requireEngineBinaryOrSkip();
type DaemonRequesterClient = ConstructorParameters<typeof OwnerYDocOutbox>[0];
const WORKSPACE_ID = "owner-ydoc-outbox-restart";
const LIMITS = {
  maxPendingBytes: 1_000_000,
  maxPendingAgeMs: 86_400_000,
} as const;

it("maps an interrupted outbox snapshot to caller-scheduled retry without authority, delivery, or ACK", async () => {
  const methods: string[] = [];
  const outbox = new OwnerYDocOutbox({
    async sendRequest(request) {
      methods.push(request.method);
      return { id: request.id, result: { kind: "readChanged" } };
    },
  }, "test-workspace");
  const calls: string[] = [];
  const drainer = new OwnerYDocOutboxDrainer(outbox, "outbox-1", {
    async freshOwnerAuthority() { calls.push("authority"); return { kind: "retry" }; },
    async deliver() { calls.push("delivery"); return { kind: "retry" }; },
  });
  try {
    await expect(drainer.drainOnce()).resolves.toBe("retry");
    expect(methods).toEqual(["ydoc.ownerOutbox.readPending"]);
    expect(calls).toEqual([]);
  } finally {
    drainer.dispose();
    outbox.dispose();
  }
});

it.each([
  { stage: "read", outcome: "receipt" },
  { stage: "authority", outcome: "receipt" },
  { stage: "authority", outcome: "quarantine" },
  { stage: "delivery", outcome: "receipt" },
  { stage: "delivery", outcome: "quarantine" },
] as const)("stops after disposal during $stage with a $outcome result", async ({ stage, outcome }) => {
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const boundary = async (current: typeof stage) => {
    calls.push(current);
    if (current === stage) {
      markReached();
      await held;
    }
  };
  class TestOutbox extends OwnerYDocOutbox {
    override async readHead(): Promise<Awaited<ReturnType<OwnerYDocOutbox["readHead"]>>> {
      await boundary("read");
      return {
        outboxId: "outbox-1",
        binding: {
          workspaceId: "workspace-1", mainVersionId: "main", objectId: "object-1",
          lineageClaimId: "lineage-1", currentPath: "owner.md", selectorPaths: ["owner.md"],
          restoreFenceGeneration: 0,
        },
        baseUpdate: new Uint8Array([0, 0]), baseUpdateDigest: "a".repeat(64),
        state: "active", pendingBytes: 1, oldestEntryAtMs: 0,
        quarantineReason: null, observedBinding: null,
        entry: { sequence: 1, appendKey: "append-1", deliveryId: "delivery-1",
          update: new Uint8Array([1]), updateDigest: "b".repeat(64), byteLength: 1, createdAtMs: 0 },
      };
    }

    override async acknowledge() {
      calls.push("ACK");
      return { acknowledged: 1, pendingBytes: 0, oldestEntryAtMs: null };
    }

    override async quarantine(): Promise<void> {
      calls.push("quarantine");
    }
  }
  const outbox = new TestOutbox({ async sendRequest() { throw new Error("Unexpected daemon request."); } }, "test-workspace");
  const drainer = new OwnerYDocOutboxDrainer(outbox, "outbox-1", {
    async freshOwnerAuthority() {
      await boundary("authority");
      return stage === "authority" && outcome === "quarantine"
        ? { kind: "quarantine", reason: "binding changed" }
        : { kind: "authority", authority: { value: {}, hostEpoch: parseHostEpoch(1) } };
    },
    async deliver() {
      await boundary("delivery");
      return outcome === "quarantine"
        ? { kind: "quarantine", reason: "binding changed" }
        : { kind: "receipt", receipt: { deliveryId: "delivery-1", updateDigest: "b".repeat(64),
          journalCursor: 1, acceptingHostEpoch: parseHostEpoch(1) } };
    },
  });
  const draining = drainer.drainOnce();
  try {
    await reached;
    drainer.dispose();
    release();
    await expect(draining).resolves.toBe("retry");
    expect(calls).toEqual(stage === "read" ? ["read"]
      : stage === "authority" ? ["read", "authority"] : ["read", "authority", "delivery"]);
  } finally {
    drainer.dispose();
    release();
    await draining.catch(() => undefined);
    outbox.dispose();
  }
});

class AppendGate implements DaemonRequesterClient {
  private releaseGate: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });
  private markSeen: (() => void) | null = null;
  readonly seen = new Promise<void>((resolve) => {
    this.markSeen = resolve;
  });

  constructor(private readonly inner: DaemonRequesterClient) {}

  get helloAck(): DaemonRequesterClient["helloAck"] {
    return this.inner.helloAck;
  }

  onBlob: DaemonRequesterClient["onBlob"] = (handler) => {
    if (this.inner.onBlob === undefined) {
      throw new Error("The real daemon client does not expose blob delivery.");
    }
    return this.inner.onBlob(handler);
  };

  async sendRequest(request: Request): Promise<Response> {
    if (request.method === "ydoc.ownerOutbox.append") {
      this.markSeen?.();
      await this.gate;
    }
    return this.inner.sendRequest(request);
  }

  open(): void {
    this.releaseGate?.();
  }
}

it.skipIf(engine.missing)("reads an owner queue larger than a daemon control frame through complete verified pages", async () => {
  const root = await createTestScratch("dohc-owner-outbox-pages-");
  await mkdir(join(root, ".dohc", "engine"), { recursive: true });
  await writeFile(join(root, ".dohc", "engine", "SHADOW_CLONE"),
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "utf8");
  await writeFile(join(root, "owner.md"), "Owner outbox frame fixture", "utf8");
  // Match the real-session helper's aggregate-load allowance for startup smoke.
  const lifecycle = createRealDaemonLifecycle({
    command: engine.require(), maxRestarts: 0,
  });
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const workspace = { workspaceId: "owner-outbox-frame", rootPath: root, attachmentId: Symbol("owner-pages") };
  const capture = createWorkspaceEngineCapture({
    ...workspace, rustEngineSessions: sessions,
  });
  try {
    await lifecycle.start();
    capture.captureBatch([{ path: "owner.md", operation: "update" }]);
    await capture.flush();
    const main = (await capture.listVersions()).versions.find((version) => version.kind === "main");
    const objectId = await capture.fileObjectIdForPath("owner.md");
    if (main === undefined || objectId === null) throw new Error("Fixture main or object is missing.");
    await sessions.run(workspace, async ({ client, workspace: handle }) => {
      const pageResponses: Response[] = [];
      const outbox = new OwnerYDocOutbox({
        async sendRequest(request) {
          const response = await client.sendRequest(request);
          if (request.method === "ydoc.ownerOutbox.readPending") pageResponses.push(response);
          return response;
        },
      }, handle);
      try {
        const binding: LiveObjectBinding = {
          workspaceId: workspace.workspaceId, mainVersionId: main.id, objectId,
          lineageClaimId: `lineage-${objectId}`, currentPath: "owner.md", selectorPaths: ["owner.md"],
          restoreFenceGeneration: 0,
        };
        let outboxId = "";
        const update = new Uint8Array(1_048_576).fill(37);
        for (let index = 0; index < 7; index += 1) {
          const appended = await outbox.append({
            binding, baseUpdate: new Uint8Array([0, 0]), update, appendKey: `frame-${index}`,
            limits: { maxPendingBytes: update.length * 8, maxPendingAgeMs: 86_400_000 },
          });
          outboxId = appended.outboxId;
        }
        const pending = await outbox.readPending(outboxId);
        expect(pending.entries).toHaveLength(7);
        expect(pending.pendingBytes).toBe(update.length * 7);
        expect(pending.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        for (const entry of pending.entries) expect(entry.update).toEqual(update);
        const wireSizes = pageResponses.map((response) => Buffer.byteLength(JSON.stringify({ type: "response", ...response })));
        expect(Math.max(...wireSizes)).toBeLessThanOrEqual(8 * 1_048_576);
        expect(wireSizes.reduce((sum, length) => sum + length, 0)).toBeGreaterThan(8 * 1_048_576);

        pageResponses.length = 0;
        const delivered: number[] = [];
        const drainer = new OwnerYDocOutboxDrainer(outbox, outboxId, {
          async freshOwnerAuthority() {
            return { kind: "authority", authority: { value: {}, hostEpoch: parseHostEpoch(1) } };
          },
          async deliver(_authority, envelope) {
            delivered.push(envelope.sequence);
            return { kind: "receipt", receipt: {
              deliveryId: envelope.deliveryId, updateDigest: envelope.updateDigest,
              journalCursor: envelope.sequence, acceptingHostEpoch: parseHostEpoch(1),
            } };
          },
        });
        try {
          for (let index = 0; index < 7; index += 1) {
            await expect(drainer.drainOnce()).resolves.toBe("acknowledged");
          }
          await expect(drainer.drainOnce()).resolves.toBe("empty");
          expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7]);
          const updateBytes = pageResponses.reduce((total, response) => {
            const page = response.result as { part?: string; bytesBase64?: string } | undefined;
            return total + (page?.part === "update" ? Buffer.from(page.bytesBase64!, "base64").length : 0);
          }, 0);
          expect(updateBytes).toBe(update.length * 7);
        } finally {
          drainer.dispose();
        }
      } finally {
        outbox.dispose();
      }
    });
  } finally {
    await capture.stop().catch(() => undefined);
    await sessions.closeAll().catch(() => undefined);
    await lifecycle.stop().catch(() => undefined);
  }
}, 120_000);

class FakeOwnerHost implements OwnerYDocDelivery {
  readonly journal: { deliveryId: string; updateDigest: string }[] = [];
  readonly authorship: { deliveryId: string; startCursor: number; endCursor: number }[] = [];
  readonly appliedDeliveryIds: string[] = [];
  readonly delivered: OwnerYDocDeliveryEnvelope[] = [];
  readonly authorityEpochs: number[] = [];
  readonly doc = new Y.Doc();
  authorityCalls = 0;
  readonly receipts = new Map<string, LiveUpdateReceipt>();

  async freshOwnerAuthority(): Promise<{
    kind: "authority";
    authority: FreshOwnerAuthority;
  }> {
    this.authorityCalls += 1;
    const hostEpoch = parseHostEpoch(this.authorityCalls);
    this.authorityEpochs.push(hostEpoch);
    return {
      kind: "authority",
      authority: {
        value: { owner: true },
        hostEpoch,
      },
    };
  }

  async deliver(
    authority: FreshOwnerAuthority,
    envelope: OwnerYDocDeliveryEnvelope,
  ): Promise<OwnerYDocDeliveryResult> {
    this.delivered.push(envelope);
    const stored = this.receipts.get(envelope.deliveryId);
    if (stored !== undefined) return { kind: "receipt", receipt: stored };

    Y.applyUpdate(
      this.doc,
      Y.mergeUpdates([envelope.baseUpdate, envelope.update]),
    );
    this.appliedDeliveryIds.push(envelope.deliveryId);
    this.journal.push({
      deliveryId: envelope.deliveryId,
      updateDigest: envelope.updateDigest,
    });
    this.authorship.push({
      deliveryId: envelope.deliveryId,
      startCursor: 1,
      endCursor: 1,
    });
    const receipt: LiveUpdateReceipt = {
      deliveryId: envelope.deliveryId,
      updateDigest: envelope.updateDigest,
      journalCursor: 1,
      acceptingHostEpoch: authority.hostEpoch,
    };
    this.receipts.set(envelope.deliveryId, receipt);
    // The host committed and retained its receipt, but this response was lost.
    return { kind: "retry" };
  }
}

function bodyText(doc: Y.Doc): Y.XmlText {
  const first = doc.getXmlFragment("body").get(0);
  if (!(first instanceof Y.XmlElement)) {
    throw new Error("The document body has no first block.");
  }
  const text = first.get(0);
  if (!(text instanceof Y.XmlText)) {
    throw new Error("The document's first block holds no text.");
  }
  return text;
}

it.skipIf(engine.missing)("acknowledges an in-flight receipt after a concurrent append seals the owner queue", async () => {
  const root = await createTestScratch("dohc-owner-outbox-sealed-receipt-");
  await mkdir(join(root, ".dohc", "engine"), { recursive: true });
  await writeFile(join(root, ".dohc", "engine", "SHADOW_CLONE"),
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "utf8");
  await writeFile(join(root, "owner.md"), "Owner receipt", "utf8");
  const doc = markdownToYDoc("Owner receipt");
  const baseUpdate = Y.encodeStateAsUpdate(doc);
  const beforeA = Y.encodeStateVector(doc);
  bodyText(doc).insert(bodyText(doc).length, " A");
  const updateA = Y.encodeStateAsUpdate(doc, beforeA);
  const beforeB = Y.encodeStateVector(doc);
  bodyText(doc).insert(bodyText(doc).length, " B");
  const updateB = Y.encodeStateAsUpdate(doc, beforeB);
  const limits = { ...LIMITS, maxPendingBytes: updateA.length + updateB.length };
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const workspace = { workspaceId: "owner-outbox-sealed-receipt", rootPath: root, attachmentId: Symbol("owner-receipt") };
  const capture = createWorkspaceEngineCapture({
    ...workspace, rustEngineSessions: sessions,
  });
  try {
    await lifecycle.start();
    capture.captureBatch([{ path: "owner.md", operation: "update" }]);
    await capture.flush();
    const main = (await capture.listVersions()).versions.find((version) => version.kind === "main");
    const objectId = await capture.fileObjectIdForPath("owner.md");
    if (main === undefined || objectId === null) throw new Error("Fixture main or object is missing.");
    await sessions.run(workspace, async ({ client, workspace: handle }) => {
      const outbox = new OwnerYDocOutbox(client, handle);
      const host = new FakeOwnerHost();
      const reached = deferred();
      const release = deferred();
      let drainer: OwnerYDocOutboxDrainer | undefined;
      let draining: ReturnType<OwnerYDocOutboxDrainer["drainOnce"]> | undefined;
      try {
        const binding: LiveObjectBinding = {
          workspaceId: workspace.workspaceId, mainVersionId: main.id, objectId,
          lineageClaimId: `lineage-${objectId}`, currentPath: "owner.md", selectorPaths: ["owner.md"],
          restoreFenceGeneration: 0,
        };
        const first = await outbox.append({ binding, baseUpdate, update: updateA, appendKey: "A", limits });
        expect(first.state).toBe("active");
        drainer = new OwnerYDocOutboxDrainer(outbox, first.outboxId, {
          freshOwnerAuthority: () => host.freshOwnerAuthority(),
          async deliver(authority, envelope) {
            await host.deliver(authority, envelope);
            const receipt = host.receipts.get(envelope.deliveryId);
            if (receipt === undefined) throw new Error("Host did not retain its committed receipt.");
            reached.resolve();
            await release.promise;
            return { kind: "receipt", receipt };
          },
        });
        draining = drainer.drainOnce();
        await Promise.race([
          reached.promise,
          draining.then(() => { throw new Error("Drain ended before held delivery."); }),
        ]);
        expect(host.appliedDeliveryIds).toEqual([first.deliveryId]);
        const second = await outbox.append({ binding, baseUpdate, update: updateB, appendKey: "B", limits });
        expect(second.outboxId).toBe(first.outboxId);
        expect(second.state).toBe("sealed");
        expect(second.pendingBytes).toBe(limits.maxPendingBytes);
        release.resolve();
        await expect(draining).resolves.toBe("acknowledged");
        const pending = await outbox.readPending(first.outboxId);
        expect(pending.state).toBe("sealed");
        expect(pending.baseUpdate).toEqual(baseUpdate);
        expect(pending.pendingBytes).toBe(updateB.length);
        expect(pending.entries).toHaveLength(1);
        expect(pending.entries[0]).toMatchObject({ sequence: second.sequence, deliveryId: second.deliveryId, update: updateB });
        await expect(outbox.append({ binding, baseUpdate, update: updateB, appendKey: "C", limits })).rejects.toThrow("owner-outbox-frozen");
        expect(await drainer.drainOnce()).toBe("acknowledged");
        expect(host.authorityCalls).toBe(2);
        expect(host.delivered).toHaveLength(2);
        const drained = await outbox.readPending(first.outboxId);
        expect(drained.state).toBe("active");
        expect(drained.entries).toEqual([]);
        await expect(outbox.append({ binding, baseUpdate, update: updateB, appendKey: "C", limits })).resolves.toMatchObject({state: "active"});
      } finally {
        drainer?.dispose();
        release.resolve();
        await draining?.catch(() => undefined);
        outbox.dispose();
        host.doc.destroy();
      }
    });
  } finally {
    await capture.stop().catch(() => undefined);
    await sessions.closeAll().catch(() => undefined);
    await lifecycle.stop().catch(() => undefined);
    doc.destroy();
  }
}, 120_000);

it.skipIf(engine.missing)(
  "replays one durable owner edit after main and daemon restart and reuses its delivery id after a lost receipt",
  async () => {
    const root = await createTestScratch("dohc-owner-outbox-");
    await mkdir(join(root, ".dohc", "engine"), { recursive: true });
    await writeFile(
      join(root, ".dohc", "engine", "SHADOW_CLONE"),
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "utf8",
    );
    const path = "owner-edit.md";
    const initialMarkdown = "# Owner edit\n\nBefore delivery";
    await writeFile(join(root, path), initialMarkdown, "utf8");

    const ownerDoc = markdownToYDoc(initialMarkdown);
    const baseUpdate = Y.encodeStateAsUpdate(ownerDoc);
    const baseStateVector = Y.encodeStateVector(ownerDoc);
    bodyText(ownerDoc).insert(bodyText(ownerDoc).length, " after restart");
    const ownerUpdate = Y.encodeStateAsUpdate(ownerDoc, baseStateVector);
    const expectedMarkdown = yDocToMarkdown(ownerDoc);

    let lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    let sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const workspace = {
      workspaceId: WORKSPACE_ID,
      rootPath: root,
      attachmentId: Symbol("owner-outbox-attachment"),
    };
    let capture = createWorkspaceEngineCapture({
      ...workspace,
      rustEngineSessions: sessions,
    });

    try {
      capture.captureBatch([{ path, operation: "update" }]);
      await capture.flush();
      const versions = await capture.listVersions();
      const mainVersion = versions.versions.find((version) => version.kind === "main");
      if (mainVersion === undefined) throw new Error("Main version was not created.");
      const objectId = await capture.fileObjectIdForPath(path);
      if (objectId === null) throw new Error("Captured file has no object ID.");
      const binding: LiveObjectBinding = {
        workspaceId: WORKSPACE_ID,
        mainVersionId: mainVersion.id,
        objectId,
        lineageClaimId: `lineage-${objectId}`,
        currentPath: path,
        selectorPaths: [path],
        restoreFenceGeneration: 0,
      };

      let appendSettled = false;
      const appended = sessions.run(workspace, async (engineBinding) => {
        const gate = new AppendGate(engineBinding.client);
        const outbox = new OwnerYDocOutbox(gate, engineBinding.workspace);
        const append = outbox.append({
          binding,
          baseUpdate,
          appendKey: "owner-edit-1",
          update: ownerUpdate,
          limits: LIMITS,
        });
        void append.then(
          () => {
            appendSettled = true;
          },
          () => {
            appendSettled = true;
          },
        );
        await gate.seen;
        expect(appendSettled).toBe(false);
        gate.open();
        const result = await append;
        outbox.dispose();
        return result;
      });
      const appendResult = await appended;

      await capture.stop();
      await sessions.closeAll();
      await lifecycle.stop();

      lifecycle = createRealDaemonLifecycle({
        command: engine.require(),
        maxRestarts: 0,
      });
      await lifecycle.start();
      sessions = createRealDaemonWorkspaceSessions(lifecycle);
      capture = createWorkspaceEngineCapture({
        ...workspace,
        rustEngineSessions: sessions,
      });

      await sessions.run(workspace, async (engineBinding) => {
        const outbox = new OwnerYDocOutbox(
          engineBinding.client,
          engineBinding.workspace,
        );
        const host = new FakeOwnerHost();
        const firstDrainer = new OwnerYDocOutboxDrainer(
          outbox,
          appendResult.outboxId,
          host,
        );
        expect(await firstDrainer.drainOnce()).toBe("retry");
        firstDrainer.dispose();

        const secondDrainer = new OwnerYDocOutboxDrainer(
          outbox,
          appendResult.outboxId,
          host,
        );
        expect(await secondDrainer.drainOnce()).toBe("acknowledged");

        expect(host.authorityCalls).toBe(2);
        expect(host.authorityEpochs).toEqual([1, 2]);
        expect(host.delivered).toHaveLength(2);
        expect(host.delivered[1]?.deliveryId).toBe(host.delivered[0]?.deliveryId);
        expect(host.delivered[1]?.updateDigest).toBe(host.delivered[0]?.updateDigest);
        expect(
          host.receipts.get(host.delivered[0]!.deliveryId)?.acceptingHostEpoch,
        ).toBe(1);
        expect(host.journal).toHaveLength(1);
        expect(host.authorship).toHaveLength(1);
        expect(host.appliedDeliveryIds).toHaveLength(1);
        expect(yDocToMarkdown(host.doc)).toBe(expectedMarkdown);
        expect((await outbox.readPending(appendResult.outboxId)).entries).toEqual([]);
        secondDrainer.dispose();
        outbox.dispose();
      });
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  120_000,
);
