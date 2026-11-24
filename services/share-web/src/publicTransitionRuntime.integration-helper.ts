import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect as browserExpect } from "@playwright/test";
import { expect } from "vitest";
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type { startServiceLiveHost } from "../../sync-relay/src/serviceLiveHost.js";
import type { SyncRelayStorage } from "../../sync-relay/src/storage.js";
import type { createPublicLinkWireProof } from "./publicLinkWireProof.integration-helper.js";
import {
  transitionNames,
  workloadHash as hash,
  validateInterruptedPublicUpdate,
  type LoadedPublicTransitions,
} from "./publicTransitionWorkload.integration-helper.js";

export interface PublicProofPage {
  context: BrowserContext;
  page: Page;
  editor: Locator;
  discriminator: string;
}
export interface PublicTransitionFixture {
  document: LiveDocumentKey;
  path: string;
  link: { url: string; shareId: string; grantId: string };
}
export interface PublicTransitionHarness {
  root: string;
  workspace: string;
  audience: string;
  concurrency: number;
  timeoutMs: number;
  storage: SyncRelayStorage;
  ownerUserId: string;
  evidence: Record<string, unknown>;
  validate: Parameters<typeof validateInterruptedPublicUpdate>[0]["validate"];
  interruptedBounds: Parameters<typeof validateInterruptedPublicUpdate>[0]["bounds"];
  assertTicketCapacity(grantId: string): unknown;
  host(): Awaited<ReturnType<typeof startServiceLiveHost>>;
  restart(): Promise<void>;
  listeners(): number;
  allListeners(): number;
  ownerRequest(path: string, body?: unknown): Promise<any>;
  register(
    id: string,
    checkpoint: Uint8Array,
    markdown: Uint8Array,
  ): Promise<PublicTransitionFixture>;
  openLink(url: string, index: number): Promise<PublicProofPage>;
  wire: ReturnType<typeof createPublicLinkWireProof>;
}
type Step = Omit<LoadedPublicTransitions["cases"]["view"]["updates"][number], "bytes"> & {
  bytes: Uint8Array;
};

export async function assertPublicApplication(
  h: PublicTransitionHarness,
  fixture: PublicTransitionFixture,
  step: Step,
) {
  const current = h.storage.resolveCurrentLiveDocumentBinding({
    document: fixture.document,
    actor: { kind: "owner", userId: h.ownerUserId },
  });
  if (current.kind !== "current") throw new Error("Transition native binding missing.");
  const native = await h.host().captureNative(current.binding);
  const ack = await native.client.readLiveApplicationAck(
    {
      id: native.nextRequestId(),
      workspace: native.workspace,
      registrationId: native.registrationId,
      deadlineMs: native.deadlineMs,
    },
    { deliveryId: step.deliveryId, updateDigest: hash(step.bytes) },
  );
  expect(ack).toMatchObject({ deliveryId: step.deliveryId, updateDigest: hash(step.bytes) });
  return ack;
}

export async function runPublicTransitions(
  h: PublicTransitionHarness,
  workload: LoadedPublicTransitions,
) {
  const results: Record<string, unknown>[] = [];
  h.evidence.loadedTransitions = results;
  for (const name of transitionNames) {
    const selected = workload.cases[name],
      fixture = await h.register(
        `transition-${name}`,
        selected.baseline.checkpoint,
        selected.baseline.markdown,
      );
    const peers: PublicProofPage[] = [];
    for (let index = 0; index < h.concurrency; index++)
      peers.push(await h.openLink(fixture.link.url, index));
    await browserExpect.poll(h.listeners, { timeout: h.timeoutMs }).toBe(h.concurrency);
    for (const peer of peers)
      await browserExpect
        .poll(async () => hash(Buffer.from((await peer.editor.textContent()) ?? "")), {
          timeout: h.timeoutMs,
        })
        .toBe(hash(selected.baseline.editorText));
    const writer = peers.pop()!;
    await writer.page.getByRole("button", { name: "Done", exact: true }).click();
    await browserExpect.poll(h.listeners, { timeout: h.timeoutMs }).toBe(h.concurrency - 1);
    let socket = await h.wire.connect(
      writer.context,
      await h.wire.ticket(writer.context, writer.discriminator, fixture.document.objectId),
      `transition-${name}`,
    );
    await socket.sync();
    const receipts: Record<string, unknown>[] = [];
    const stage = {
      name,
      concurrency: h.concurrency,
      browserReceivers: h.concurrency - 1,
      activeSubmitters: 1,
      interruptedDelivery: selected.interrupted!.deliveryId,
      receipts,
      verdict: "INCOMPLETE",
    };
    results.push(stage);
    async function apply(step: Step) {
      const submittedAt = Date.now(),
        outcome = await socket.submit(step.bytes, step.deliveryId);
      if (outcome.kind !== "result" || outcome.result !== "success")
        throw new Error(`Transition update refused: ${step.deliveryId}`);
      const ack = await assertPublicApplication(h, fixture, step);
      for (const peer of peers)
        await browserExpect
          .poll(async () => hash(Buffer.from((await peer.editor.textContent()) ?? "")), {
            timeout: h.timeoutMs,
          })
          .toBe(hash(step.expected.editorText));
      expect(hash(Buffer.from(yDocToMarkdown(socket.doc)))).toBe(hash(step.expected.markdown));
      receipts.push({
        deliveryId: step.deliveryId,
        submittedAt,
        hostReceiptObservedAt: socket.receiptTimes.get(step.deliveryId),
        renderedAt: Date.now(),
        ack,
      });
    }
    try {
      for (const step of selected.updates) await apply(step);
      const before = selected.updates.at(-1)!.expected;
      await browserExpect.poll(h.listeners, { timeout: h.timeoutMs }).toBe(h.concurrency);
      const actualCut = h.storage.readLiveUpdateJournalCut({ document: fixture.document });
      if (actualCut.kind !== "cut")
        throw new Error("Interrupted update lacks a current journal cut.");
      const candidateAdmission = validateInterruptedPublicUpdate({
        document: fixture.document,
        currentPath: fixture.path,
        checkpoint: actualCut.cut.checkpoint.bytes,
        suffix: actualCut.cut.suffix.map((row) => row.bytes),
        candidate: selected.interrupted!.bytes,
        bounds: h.interruptedBounds,
        validate: h.validate,
      });
      Object.assign(stage, { candidateAdmission });
      const held = await socket.partialTransfer(
        selected.interrupted!.bytes,
        selected.interrupted!.deliveryId,
      );
      const interruptedAt = Date.now(),
        oldEpoch = socket.hostEpoch;
      if (name === "restart") await h.restart();
      else if (name === "staleFrame") {
        // Replay the previous, already completed transfer ID on the still-open socket.
        expect(socket.ws.readyState).toBe(WebSocket.OPEN);
        await socket.hostileSend({ ...held, transferId: held.transferId - 1 });
      } else if (name === "selectorDrift") {
        await h.ownerRequest(`/sync/${fixture.document.workspaceId}/log`, {
          originId: `selector-${name}`,
          ops: [
            {
              originSeq: 0,
              opKind: "moment.append",
              recordedAtMs: Date.now(),
              payload: {
                objectId: fixture.document.objectId,
                momentId: `move-${name}`,
                versionId: fixture.document.mainVersionId,
                recordedAtMs: Date.now(),
                operation: "rename",
                metadata: { origin: "user" },
                beforePresent: "present",
                path: `outside/${name}.md`,
                payloadBeforePath: fixture.path,
                payloadAfterPath: `outside/${name}.md`,
                payloadBeforeBlobSha256: hash(selected.baseline.markdown),
                payloadAfterBlobSha256: hash(selected.baseline.markdown),
                payloadAfterContentKind: "text",
                payloadAfterByteLength: selected.baseline.markdown.length,
              },
            },
          ],
        });
      } else {
        await h.ownerRequest(
          `/sync/shares/${fixture.link.shareId}/links/${fixture.link.grantId}/retune`,
          {
            workspaceId: fixture.document.workspaceId,
            access: "view",
            expectedDependentGrantIds: [],
          },
        );
      }
      if (name !== "staleFrame") await socket.hostileSend(held);
      await socket.until(() => socket.closed !== undefined);
      for (const path of [
        join(h.root, "relay/relay.sqlite"),
        join(h.workspace, ".dohc/engine/engine.db"),
      ]) {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          const table = path.includes("relay.sqlite")
            ? "sync_relay_live_update_journal"
            : "live_device_update_applications";
          expect(
            db
              .prepare(`SELECT delivery_id FROM ${table} WHERE delivery_id = ?`)
              .all(selected.interrupted!.deliveryId),
          ).toEqual([]);
        } finally {
          db.close();
        }
      }
      if (name === "selectorDrift" || name === "accessChange") {
        for (const peer of peers)
          await browserExpect(peer.editor).toHaveAttribute("contenteditable", "false", {
            timeout: h.timeoutMs,
          });
        Object.assign(stage, {
          deniedTicketCapacity: h.assertTicketCapacity(fixture.link.grantId),
        });
        const denied = await writer.context.request.post(h.audience + "/api/live/link-ticket", {
          data: { discriminator: writer.discriminator, objectId: fixture.document.objectId },
          headers: { origin: h.audience },
        });
        expect(denied.status()).toBe(404);
      }
      if (selected.resumed) {
        if (name === "restart")
          for (const peer of peers) {
            await peer.page.getByRole("button", { name: "Retry connection", exact: true }).click();
            await browserExpect(peer.editor).toHaveAttribute("contenteditable", "true", {
              timeout: h.timeoutMs,
            });
          }
        socket = await h.wire.connect(
          writer.context,
          await h.wire.ticket(writer.context, writer.discriminator, fixture.document.objectId),
          `resumed-${name}`,
        );
        await socket.sync();
        if (name === "restart") expect(socket.hostEpoch!).toBe(oldEpoch!);
        await browserExpect.poll(h.listeners, { timeout: h.timeoutMs }).toBe(h.concurrency);
        await apply(selected.resumed!);
      }
      if (name !== "selectorDrift") {
        const expected = selected.resumed?.expected ?? before;
        const settled = await h.host().settle(fixture.document);
        expect(settled).toMatchObject({ materialized: true });
        expect(hash(readFileSync(join(h.workspace, fixture.path)))).toBe(hash(expected.markdown));
      }
      Object.assign(stage, { interruptedAt, verdict: "PASS" });
    } finally {
      await socket.close();
      await writer.context.close();
      for (const peer of peers) await peer.context.close();
    }
    await browserExpect.poll(h.allListeners, { timeout: h.timeoutMs }).toBe(0);
  }
  return results;
}
