import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {WebSocket} from "ws";
import type {BrowserContext, Locator, Page} from "@playwright/test";
import {expect as browserExpect} from "@playwright/test";
import {expect} from "vitest";
import * as Y from "yjs";
import {yDocToMarkdown} from "@dohc/ydoc-projection";
import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import {OwnerRestoreActionResponse} from "../../../apps/desktop/src/ipc/ownerRestoreContract.js";
import type {startServiceLiveHost} from "../../sync-relay/src/serviceLiveHost.js";
import type {SyncRelayStorage} from "../../sync-relay/src/storage.js";
import type {createPublicLinkWireProof} from "./publicLinkWireProof.integration-helper.js";
import {transitionNames, workloadHash as hash, deriveRestoreContinuation, validateInterruptedPublicUpdate, type LoadedPublicTransitions} from "./publicTransitionWorkload.integration-helper.js";

export interface PublicProofPage {context: BrowserContext; page: Page; editor: Locator; discriminator: string}
export interface PublicTransitionFixture {document: LiveDocumentKey; path: string; link: {url: string; shareId: string; grantId: string}}
export interface PublicTransitionHarness {
  root: string; workspace: string; audience: string; concurrency: number; timeoutMs: number;
  storage: SyncRelayStorage; ownerUserId: string;
  evidence: Record<string, unknown>;
  validate: Parameters<typeof validateInterruptedPublicUpdate>[0]["validate"];
  interruptedBounds: Parameters<typeof validateInterruptedPublicUpdate>[0]["bounds"];
  assertTicketCapacity(grantId: string): unknown;
  host(): Awaited<ReturnType<typeof startServiceLiveHost>>;
  restart(): Promise<void>;
  listeners(): number;
  ownerRequest(path: string, body?: unknown): Promise<any>;
  register(id: string, checkpoint: Uint8Array, markdown: Uint8Array): Promise<PublicTransitionFixture>;
  openLink(url: string, index: number): Promise<PublicProofPage>;
  wire: ReturnType<typeof createPublicLinkWireProof>;
}
type Step = LoadedPublicTransitions["cases"]["view"]["updates"][number];

export async function assertPublicApplication(h: PublicTransitionHarness, fixture: PublicTransitionFixture, step: Step) {
  const current = h.storage.resolveCurrentLiveDocumentBinding({document: fixture.document,
    actor: {kind: "owner", userId: h.ownerUserId, shareId: fixture.link.shareId}});
  if (current.kind !== "current") throw new Error("Transition native binding missing.");
  const native = await h.host().captureNative(current.binding);
  const ack = await native.client.readLiveApplicationAck({id: native.nextRequestId(), workspace: native.workspace,
    registrationId: native.registrationId, deadlineMs: native.deadlineMs}, {deliveryId: step.deliveryId, updateDigest: hash(step.bytes)});
  expect(ack).toMatchObject({deliveryId: step.deliveryId, updateDigest: hash(step.bytes)}); return ack;
}

export async function runPublicTransitions(h: PublicTransitionHarness, workload: LoadedPublicTransitions) {
  const results: Record<string, unknown>[] = [];
  h.evidence.loadedTransitions = results;
  for (const name of transitionNames) {
    const selected = workload.cases[name], fixture = await h.register(`transition-${name}`, selected.baseline.checkpoint, selected.baseline.markdown);
    const peers: PublicProofPage[] = [];
    for (let index = 0; index < h.concurrency; index++) peers.push(await h.openLink(fixture.link.url, index));
    await browserExpect.poll(h.listeners, {timeout: h.timeoutMs}).toBe(h.concurrency);
    for (const peer of peers) await browserExpect.poll(async () => hash(Buffer.from(await peer.editor.textContent() ?? "")), {timeout: h.timeoutMs}).toBe(hash(selected.baseline.editorText));
    const writer = peers.pop()!;
    const extraContexts: BrowserContext[] = [];
    let restoredViewer: Page | undefined;
    let continuationEvidence: Record<string, unknown> | undefined;
    await writer.page.getByRole("button", {name: "Back to shared files", exact: true}).click();
    await browserExpect.poll(h.listeners, {timeout: h.timeoutMs}).toBe(h.concurrency - 1);
    let socket = await h.wire.connect(writer.context, await h.wire.ticket(writer.context, writer.discriminator, fixture.document.objectId), `transition-${name}`);
    await socket.sync();
    const receipts: Record<string, unknown>[] = [];
    const stage = {name, concurrency: h.concurrency, browserReceivers: h.concurrency - 1, activeSubmitters: 1,
      interruptedDelivery: selected.interrupted!.deliveryId, receipts, verdict: "INCOMPLETE"};
    results.push(stage);
    async function apply(step: Step) {
      const submittedAt = Date.now(), outcome = await socket.submit(step.bytes, step.deliveryId);
      if (outcome.kind !== "result" || outcome.result !== "success") throw new Error(`Transition update refused: ${step.deliveryId}`);
      const ack = await assertPublicApplication(h, fixture, step);
      for (const peer of peers) await browserExpect.poll(async () => hash(Buffer.from(await peer.editor.textContent() ?? "")), {timeout: h.timeoutMs}).toBe(hash(step.expected.editorText));
      expect(hash(Buffer.from(yDocToMarkdown(socket.doc)))).toBe(hash(step.expected.markdown));
      receipts.push({deliveryId: step.deliveryId, submittedAt, hostReceiptObservedAt: socket.receiptTimes.get(step.deliveryId), renderedAt: Date.now(), ack});
    }
    try {
      for (const step of selected.updates) await apply(step);
      const before = selected.updates.at(-1)!.expected;
      await browserExpect.poll(h.listeners, {timeout: h.timeoutMs}).toBe(h.concurrency);
      const actualCut = h.storage.readLiveUpdateJournalCut({document: fixture.document});
      if (actualCut.kind !== "cut") throw new Error("Interrupted update lacks a current journal cut.");
      const candidateAdmission = validateInterruptedPublicUpdate({document: fixture.document, currentPath: fixture.path,
        checkpoint: actualCut.cut.checkpoint.bytes, suffix: actualCut.cut.suffix.map(row => row.bytes), candidate: selected.interrupted!.bytes,
        bounds: h.interruptedBounds, validate: h.validate});
      Object.assign(stage, {candidateAdmission});
      const held = await socket.partialTransfer(selected.interrupted!.bytes, selected.interrupted!.deliveryId);
      const interruptedAt = Date.now(), oldEpoch = socket.hostEpoch;
      let restored: unknown;
      if (name === "restart") await h.restart();
      else if (name === "staleFrame") {
        // Replay the previous, already completed transfer ID on the still-open socket.
        expect(socket.ws.readyState).toBe(WebSocket.OPEN);
        await socket.hostileSend({...held, transferId: held.transferId - 1});
      }
      else if (name === "selectorDrift") {
        await h.ownerRequest(`/sync/${fixture.document.workspaceId}/log`, {originId: `selector-${name}`, ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: Date.now(),
          payload: {objectId: fixture.document.objectId, momentId: `move-${name}`, versionId: fixture.document.mainVersionId, recordedAtMs: Date.now(),
            operation: "rename", metadata: {origin: "user"}, beforePresent: "present", path: `outside/${name}.md`,
            payloadBeforePath: fixture.path, payloadAfterPath: `outside/${name}.md`, payloadBeforeBlobSha256: hash(selected.baseline.markdown),
            payloadAfterBlobSha256: hash(selected.baseline.markdown), payloadAfterContentKind: "text", payloadAfterByteLength: selected.baseline.markdown.length}}]});
      } else if (name === "accessChange") {
        await h.ownerRequest(`/sync/${fixture.document.workspaceId}/shares/${fixture.link.shareId}/links/${fixture.link.grantId}/retune`,
          {workspaceId: fixture.document.workspaceId, access: "view", expectedDependentGrantIds: []});
      } else {
        // Runtime preparation generates the fence and restore update; corpus bytes never replace that authority path.
        const options = OwnerRestoreActionResponse.options.parse(await h.ownerRequest(`/sync/${fixture.document.workspaceId}/live-restores/options`, {path: fixture.path}));
        const point = options.points.find(row => row.cursor === 0); if (!point) throw new Error("Selected baseline restore point missing.");
        const plan = OwnerRestoreActionResponse.plan.parse(await h.ownerRequest(`/sync/${fixture.document.workspaceId}/live-restores/plan`, {document: options.document,
          shareId: fixture.link.shareId, grantId: fixture.link.grantId, restorePointCursor: point.cursor, restorePointReceiptDigest: point.receiptDigest}));
        const stopped = OwnerRestoreActionResponse.begin.parse(await h.ownerRequest(`/sync/${fixture.document.workspaceId}/live-restores`, {intent: plan.intent}));
        expect(stopped.phase).toBe("authority-invalidated");
        await socket.hostileSend(held);
        const prefix = `/sync/${fixture.document.workspaceId}/live-restores/${stopped.operationId}`;
        const prepared = OwnerRestoreActionResponse.prepare.parse(await h.ownerRequest(prefix + "/prepare", {})); expect(prepared.result.kind).toBe("prepared");
        const review = OwnerRestoreActionResponse.review.parse(await h.ownerRequest(prefix + "/review", {}));
        if (!review.result || "kind" in review.result) throw new Error("Transition restore review missing.");
        expect(hash(Buffer.from(review.result.content.frozenMarkdown))).toBe(hash(before.markdown));
        expect(hash(Buffer.from(review.result.content.restoredMarkdown))).toBe(hash(selected.baseline.markdown));
        restored = OwnerRestoreActionResponse.confirm.parse(await h.ownerRequest(prefix + "/confirm", {proposalDigest: review.result.proposalDigest}));
      }
      if (name !== "restore" && name !== "staleFrame") await socket.hostileSend(held);
      await socket.until(() => socket.closed !== undefined);
      for (const path of [join(h.root, "relay/relay.sqlite"), join(h.workspace, ".dohc/engine/engine.db")]) {
        const db = new DatabaseSync(path, {readOnly: true});
        try {const table = path.includes("relay.sqlite") ? "sync_relay_live_update_journal" : "live_device_update_applications";
          expect(db.prepare(`SELECT delivery_id FROM ${table} WHERE delivery_id = ?`).all(selected.interrupted!.deliveryId)).toEqual([]);
        } finally {db.close();}
      }
      if (name === "selectorDrift" || name === "accessChange" || name === "restore") {
        for (const peer of peers) await browserExpect(peer.editor).toHaveAttribute("contenteditable", "false", {timeout: h.timeoutMs});
        Object.assign(stage, {deniedTicketCapacity: h.assertTicketCapacity(fixture.link.grantId)});
        const denied = await writer.context.request.post(h.audience + "/api/live/link-ticket", {data: {discriminator: writer.discriminator, objectId: fixture.document.objectId}, headers: {origin: h.audience}});
        expect(denied.status()).toBe(404);
      }
      if (selected.resumed || selected.continuation) {
        if (name === "restore") {
          for (const peer of peers) await peer.context.close(); peers.length = 0;
          const fresh = await h.ownerRequest(`/sync/${fixture.document.workspaceId}/shares/${fixture.link.shareId}/links`, {access: "edit"});
          fixture.link = fresh;
          for (let index = 0; index < h.concurrency - 1; index++) peers.push(await h.openLink(fresh.url, index));
          const identity = await h.openLink(fresh.url, h.concurrency - 1);
          extraContexts.push(identity.context);
          await identity.page.getByRole("button", {name: "Back to shared files", exact: true}).click();
          restoredViewer = identity.page;
          socket = await h.wire.connect(identity.context, await h.wire.ticket(identity.context, identity.discriminator, fixture.document.objectId), `resumed-${name}`);
        } else {
          if (name === "restart") for (const peer of peers) {await peer.page.getByRole("button", {name: "Retry connection", exact: true}).click(); await browserExpect(peer.editor).toHaveAttribute("contenteditable", "true", {timeout: h.timeoutMs});}
          socket = await h.wire.connect(writer.context, await h.wire.ticket(writer.context, writer.discriminator, fixture.document.objectId), `resumed-${name}`);
        }
        await socket.sync();
        if (name === "restart") expect(socket.hostEpoch!).toBeGreaterThan(oldEpoch!);
        await browserExpect.poll(h.listeners, {timeout: h.timeoutMs}).toBe(h.concurrency);
        if (selected.continuation) {
          const continuation = selected.continuation;
          for (const peer of peers) await browserExpect.poll(async () => hash(Buffer.from(await peer.editor.textContent() ?? "")), {timeout: h.timeoutMs}).toBe(hash(selected.baseline.editorText));
          const directory = join(h.root, "restore-continuation"); mkdirSync(directory);
          const save = (name: string, bytes: Uint8Array) => {
            const path = join(directory, name); writeFileSync(path, bytes, {flag: "wx"});
            return {path, sha256: hash(bytes), byteLength: bytes.length};
          };
          const checkpoint = Y.encodeStateAsUpdate(socket.doc), restoredCheckpoint = save("restored-checkpoint.bin", checkpoint);
          const generated = deriveRestoreContinuation(checkpoint, continuation.recipe, selected.baseline.markdown, continuation.expected.markdown,
            [...selected.updates.map(update => update.bytes), selected.interrupted!.bytes]);
          continuationEvidence = {kind: "runtime-derived-after-native-restore", manifest: workload.manifestPin,
            recipe: continuation.recipePin, deliveryId: continuation.deliveryId, restoredCheckpoint,
            candidate: save("candidate.bin", generated.bytes), projectedMarkdown: save("projected.md", generated.markdown),
            writerClientId: generated.clientId, restoredStateVectorSha256: generated.restoredStateVectorSha256,
            expected: {markdownSha256: hash(continuation.expected.markdown), editorTextSha256: hash(continuation.expected.editorText), viewTextSha256: hash(continuation.expected.viewText)},
            preselectedCandidate: false, verdict: "INCOMPLETE"};
          Object.assign(stage, {continuation: continuationEvidence});
          save("derivation.json", Buffer.from(JSON.stringify(continuationEvidence, null, 2) + "\n"));
          const actual = h.storage.readLiveUpdateJournalCut({document: fixture.document});
          if (actual.kind !== "cut") throw new Error("Restore continuation lacks a current journal cut.");
          const admission = validateInterruptedPublicUpdate({document: fixture.document, currentPath: fixture.path,
            checkpoint: actual.cut.checkpoint.bytes, suffix: actual.cut.suffix.map(row => row.bytes), candidate: generated.bytes,
            bounds: h.interruptedBounds, validate: h.validate});
          expect(admission.projectedMarkdownSha256).toBe(hash(continuation.expected.markdown));
          const binding = h.storage.resolveCurrentLiveDocumentBinding({document: fixture.document,
            actor: {kind: "owner", userId: h.ownerUserId, shareId: fixture.link.shareId}});
          if (binding.kind !== "current") throw new Error("Restored continuation binding missing.");
          const admissionReceipt = save("admission.json", Buffer.from(JSON.stringify({admission, binding: binding.binding,
            bounds: h.interruptedBounds, checkpointSha256: hash(actual.cut.checkpoint.bytes),
            suffixSha256: actual.cut.suffix.map(row => hash(row.bytes))}, null, 2) + "\n"));
          Object.assign(continuationEvidence, {admission, admissionReceipt});
          await apply({deliveryId: continuation.deliveryId, bytes: generated.bytes, expected: continuation.expected});
        } else await apply(selected.resumed!);
      }
      if (name !== "selectorDrift") {
        const expected = selected.continuation?.expected ?? selected.resumed?.expected ?? before;
        const settled = await h.host().settle(fixture.document); expect(settled.materialized).toBe(true);
        expect(hash(readFileSync(join(h.workspace, fixture.path)))).toBe(hash(expected.markdown));
        if (restoredViewer && continuationEvidence) {
          await browserExpect.poll(async () => hash(Buffer.from(await restoredViewer!.locator("article.markdown").textContent() ?? "")), {timeout: h.timeoutMs}).toBe(hash(expected.viewText));
          Object.assign(continuationEvidence, {editorWitnessVerified: true, viewWitnessVerified: true, verdict: "PASS"});
          writeFileSync(join(h.root, "restore-continuation", "result.json"), JSON.stringify(continuationEvidence, null, 2) + "\n", {flag: "wx"});
        }
      }
      Object.assign(stage, {interruptedAt, restored, verdict: "PASS"});
    } finally {
      await socket.close(); await writer.context.close(); for (const peer of peers) await peer.context.close();
      for (const context of extraContexts) await context.close();
    }
    await browserExpect.poll(h.listeners, {timeout: h.timeoutMs}).toBe(0);
  }
  return results;
}
