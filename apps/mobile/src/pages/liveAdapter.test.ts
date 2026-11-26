import { createHash } from "node:crypto";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import {
  createLiveFrameSession,
  encodeLiveFrame,
  encodeLiveFrameSync,
  type LiveFrame,
  type LiveFrameBegin,
} from "@dohc/live-session-contract/live-frame";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { getDohcYDocBodyFragment } from "@dohc/ydoc-projection/body-fragment";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createLiveAdapter } from "../../editor/liveAdapter";
import { fromBase64, outgoing, toBase64, type FromPage, type ToPage } from "./liveBridge";
import { liveLimits } from "./liveFixtures";

// The page's side of a live connection (editor/liveAdapter.ts), run against the relay's side of the protocol through
// the bridge, as the app passes it.

const binding: LiveObjectBinding = {
  workspaceId: "ws-1",
  mainVersionId: "main",
  objectId: "obj-1",
  lineageClaimId: "claim-1",
  currentPath: "plan.md",
  selectorPaths: ["plan.md"],
  restoreFenceGeneration: 0,
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function document(text: string) {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  const content = new Y.XmlText();
  content.insert(0, text);
  paragraph.insert(0, [content]);
  getDohcYDocBodyFragment(doc).insert(0, [paragraph]);
  return doc;
}

/** The page, and the app and relay behind each connection the app opens to it. */
function page(limits = liveLimits()) {
  const policy = limits.provider.frames;
  const posted: FromPage[] = [];
  let hear = (_message: FromPage) => {};
  const adapter = createLiveAdapter({
    // The web view's messages reach the app after the page's own work, as the bridge delivers them.
    post: (message) => {
      posted.push(message);
      queueMicrotask(() => hear(message));
    },
    changed: () => undefined,
  });
  let gen = 0;
  const provider = () => adapter.provider()!;

  function connect(epoch = 1) {
    const relay = createLiveFrameSession("server", policy);
    const toPage = outgoing<ToPage>(++gen, adapter.receive);
    const mine = gen;
    const frames: LiveFrame[] = [];
    const submissions: { begin: LiveFrameBegin; bytes: Uint8Array }[] = [];
    let vector: Uint8Array | undefined;
    let transfers = 0;
    hear = (message) => {
      if (message.gen !== mine || message.type !== "frame") return;
      const received = relay.receive(fromBase64(message.data));
      frames.push(received.value.frame);
      const transfer = received.value.transfer?.value;
      if (transfer?.begin.purpose === "client-vector") vector = transfer.bytes.slice();
      if (transfer?.begin.purpose === "submit-update")
        submissions.push({ begin: transfer.begin, bytes: transfer.bytes.slice() });
      received.value.transfer?.release();
      received.release();
      toPage({ type: "sent" });
    };
    const send = (frame: LiveFrame) => {
      const lease = relay.send(frame);
      toPage({ type: "frame", data: toBase64(lease.value) });
      lease.release();
    };
    toPage({ type: "connect", limits, workspaceId: "ws-1", objectId: "obj-1" });

    return {
      toPage,
      frames,
      submissions,
      /** Welcomes the page and sends it `doc`: the page is then live. */
      async sync(doc: Y.Doc) {
        await vi.waitFor(() => expect(frames.some((frame) => frame.kind === "credit")).toBe(true));
        send({ kind: "welcome", hostEpoch: parseHostEpoch(epoch), receivePolicy: policy.receive });
        send({
          kind: "credit",
          grantedBytes: policy.maxQueuedBytes,
          grantedFrames: policy.maxQueuedFrames,
        });
        await vi.waitFor(() => expect(vector).toBeDefined());
        const bytes = encodeLiveFrameSync(
          {
            binding,
            hostVector: Y.encodeStateVector(doc),
            missingStateUpdate: Y.encodeStateAsUpdate(doc, vector),
          },
          policy.receive,
        );
        const transferId = ++transfers;
        send({
          kind: "begin",
          purpose: "initial-sync",
          transferId,
          totalBytes: bytes.length,
          digest: hash(bytes),
          appliedThroughJournalCursor: 0,
        } as LiveFrameBegin);
        for (let offset = 0; offset < bytes.length; offset += 900)
          send({ kind: "chunk", transferId, offset, bytes: bytes.subarray(offset, offset + 900) });
        await vi.waitFor(() => expect(provider().state().status).toBe("live"));
      },
      ack(item: { begin: LiveFrameBegin }) {
        if (item.begin.purpose !== "submit-update") throw new Error("Expected a submitted update.");
        send({
          kind: "result",
          result: "success",
          ack: {
            deliveryId: item.begin.deliveryId,
            updateDigest: item.begin.digest,
            journalCursor: 1,
            acceptingHostEpoch: parseHostEpoch(epoch),
            localYDocSequence: 1,
            applicationReplayed: false,
          },
        });
      },
      /** The socket ended: the app tells the page. */
      lose() {
        toPage({ type: "lost" });
      },
    };
  }
  const sentOn = (on: number) => posted.filter((message) => message.gen === on);
  const reported = (on: number) =>
    sentOn(on)
      .filter((message) => message.type === "state")
      .at(-1);
  return { adapter, provider, posted, sentOn, reported, connect };
}

function type(provider: { doc: Y.Doc }, text: string) {
  const content = (getDohcYDocBodyFragment(provider.doc).get(0) as Y.XmlElement).get(
    0,
  ) as Y.XmlText;
  content.insert(content.length, text);
}

/** Lets the page finish what it started: the provider's receive work and its sends. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the page's live connection", () => {
  it("never seeds the provider: it is empty and takes nothing ahead until the relay's sync", async () => {
    const t = page();
    const app = t.connect();
    expect(getDohcYDocBodyFragment(t.provider().doc).length).toBe(0);
    expect(t.provider().state()).toMatchObject({ status: "connecting", typingAhead: false });
    const doc = document("from the relay");
    await app.sync(doc);
    expect(getDohcYDocBodyFragment(t.provider().doc).toString()).toBe(
      getDohcYDocBodyFragment(doc).toString(),
    );
    expect(t.reported(1)).toMatchObject({ facts: { status: "live", pendingUpdates: 0 } });
  });

  it("keeps a waiting update's ID through a lost connection, and sends it again on the next", async () => {
    const t = page();
    const first = t.connect();
    const doc = document("base");
    await first.sync(doc);
    type(t.provider(), " typed");
    await vi.waitFor(() => expect(first.submissions).toHaveLength(1));
    const sent = first.submissions[0]!.begin as Extract<
      LiveFrameBegin,
      { purpose: "submit-update" }
    >;

    first.lose();
    await settled();
    expect(t.provider().state()).toMatchObject({ status: "disconnected", pendingUpdates: 1 });
    expect(t.reported(1)).toMatchObject({ facts: { pendingUpdates: 1, unsent: true } });

    const second = t.connect(2);
    await second.sync(doc);
    await vi.waitFor(() => expect(second.submissions).toHaveLength(1));
    expect(second.submissions[0]!.begin).toMatchObject({ deliveryId: sent.deliveryId });
    second.ack(second.submissions[0]!);
    await vi.waitFor(() => expect(t.provider().state().pendingUpdates).toBe(0));
    expect(t.reported(2)).toMatchObject({
      facts: { status: "live", pendingUpdates: 0, unsent: false },
    });
  });

  it("never reconnects a quarantined provider", async () => {
    const t = page();
    const first = t.connect();
    await first.sync(document("base"));
    first.toPage({
      type: "frame",
      data: toBase64(encodeLiveFrame({ kind: "close", reason: "route-fenced" }, 1024)),
    });
    await vi.waitFor(() => expect(t.provider().state().status).toBe("quarantined"));
    expect(t.sentOn(1).map((message) => message.type)).toContain("close");

    t.connect();
    await settled();
    expect(t.sentOn(2)).toEqual([
      expect.objectContaining({
        type: "state",
        facts: expect.objectContaining({ status: "quarantined" }),
      }),
      expect.objectContaining({ type: "close" }),
    ]);
  });

  it("closes the connection when the app's frames pass the provider's queue", async () => {
    const t = page(liveLimits({ frames: 2 }));
    const app = t.connect();
    const credit = toBase64(
      encodeLiveFrame({ kind: "credit", grantedBytes: 1, grantedFrames: 1 }, 1024),
    );
    for (let at = 0; at < 3; at++) app.toPage({ type: "frame", data: credit });
    await settled();
    expect(t.provider().state()).toMatchObject({ status: "quarantined", reason: "inbound-limit" });
    expect(t.sentOn(1).map((message) => message.type)).toContain("close");
  });

  it("lets no earlier connection's message change the current one, and closes on a gap", async () => {
    const t = page();
    const first = t.connect();
    first.lose();
    await settled();
    const second = t.connect();
    const doc = document("base");
    const before = t.posted.length;
    // An earlier open's lost and frame, and a later open's message that isn't its connect.
    first.lose();
    first.toPage({ type: "frame", data: toBase64(new Uint8Array([1])) });
    t.adapter.receive({ kind: "live", gen: 9, seq: 2, type: "lost" });
    await settled();
    expect(t.posted.slice(before).filter((message) => message.gen !== 2)).toEqual([]);
    await second.sync(doc);
    // A message out of order ends the connection, and the provider keeps its edits.
    t.adapter.receive({ kind: "live", gen: 2, seq: 99, type: "sent" });
    await settled();
    expect(t.provider().state().status).toBe("disconnected");
    expect(t.sentOn(2).at(-1)).toMatchObject({ type: "close" });
  });
});
