import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import {
  OwnerYDocOutbox,
  type DaemonRequesterClient,
  type LiveObjectBinding,
  type OwnerYDocDeliveryReceipt,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { EngineDaemonLifecycle } from "@dohc/workspace-engine-client/daemon";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonWorkspaceSessions } from "../testing/realDaemonWorkspaceSessions";
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
const WORKSPACE_ID = "owner-ydoc-outbox-restart";
const LIMITS = {
  maxPendingBytes: 1_000_000,
  maxPendingAgeMs: 86_400_000,
} as const;

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

class FakeOwnerHost implements OwnerYDocDelivery {
  readonly journal: { deliveryId: string; updateDigest: string }[] = [];
  readonly authorship: { deliveryId: string; startCursor: number; endCursor: number }[] = [];
  readonly appliedDeliveryIds: string[] = [];
  readonly delivered: OwnerYDocDeliveryEnvelope[] = [];
  readonly authorityEpochs: number[] = [];
  readonly doc = new Y.Doc();
  authorityCalls = 0;
  readonly receipts = new Map<string, OwnerYDocDeliveryReceipt>();

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
    const receipt: OwnerYDocDeliveryReceipt = {
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

    let lifecycle = new EngineDaemonLifecycle({
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
      daemonOwnsCapture: true,
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

      lifecycle = new EngineDaemonLifecycle({
        command: engine.require(),
        maxRestarts: 0,
      });
      await lifecycle.start();
      sessions = createRealDaemonWorkspaceSessions(lifecycle);
      capture = createWorkspaceEngineCapture({
        ...workspace,
        rustEngineSessions: sessions,
        daemonOwnsCapture: true,
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
          LIMITS,
          host,
          () => 0,
        );
        expect(await firstDrainer.drainOnce()).toBe("retry");
        firstDrainer.dispose();

        const secondDrainer = new OwnerYDocOutboxDrainer(
          outbox,
          appendResult.outboxId,
          LIMITS,
          host,
          () => 0,
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
