import {createHash} from "node:crypto";
import {expect, it, vi} from "vitest";
import {createFirstOpenPublisher} from "./firstOpenPublication";
import type {ServiceActivationConfig} from "./serviceActivationDriver";
import type {SyncRelayStorage} from "./storage";

function fixture() {
  let now = 0;
  const bytes = new TextEncoder().encode("A note.\n"), sourceDigest = createHash("sha256").update(bytes).digest("hex");
  const identity = {replicationEpoch: "epoch", streamIdentity: "stream"};
  const prepare = vi.fn<SyncRelayStorage["prepareFirstOpen"]>(async () => ({kind: "busy"}));
  const blob = vi.fn(() => bytes);
  const storage = {
    readFirstOpenStanding: ({path}: {path: string}) => path.slice(0, -3),
    captureStanding() {},
    getWorkspaceIdentity: () => identity,
    verifyWorkspaceIdentity: () => "matched",
    getEpochLogFloor: () => 0,
    readFirstOpenReceipt: () => ({kind: "absent"}),
    readFirstOpenMoment: (_workspace: string, object: string) => ({sourceMomentId: "m", sourceDigest, path: `${object}.md`, contentKind: "text", sourceByteLength: bytes.byteLength}),
    getBlob: blob,
    prepareFirstOpen: prepare,
  } as unknown as SyncRelayStorage;
  const publish = createFirstOpenPublisher({storage, namespace: "test", activation: () => ({} as ServiceActivationConfig), host: () => undefined, nowMs: () => now});
  const open = (objectId: string, workspaceId = "w") => publish({workspaceId, ownerUserId: "owner", guard() {}, signal: new AbortController().signal,
    request: {objectId, path: `${objectId}.md`, sourceMomentId: "m", sourceDigest, identity}});
  return {open, prepare, blob, advance(ms: number) {now += ms;}};
}

it("prunes expired admission entries at capacity without dropping a remaining quiet entry", async () => {
  const f = fixture();
  await f.open("expired");
  f.advance(1);
  for (let i = 1; i < 4_096; i++) await f.open(`note-${i}`);
  f.advance(59_999);
  await f.open("new", "other-workspace");
  expect(f.prepare).toHaveBeenCalledTimes(4_097);
  await f.open("note-1");
  expect(f.prepare).toHaveBeenCalledTimes(4_097);
  await f.open("expired");
  expect(f.prepare).toHaveBeenCalledTimes(4_098);
});

it("admits another workspace at capacity by evicting the oldest quiet entry, never a running entry", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;}), started = new Promise<void>(resolve => {entered = resolve;});
  f.prepare.mockImplementationOnce(async () => {entered(); await held; return {kind: "busy"};});
  const pending = f.open("running");
  await started;
  try {
    for (let i = 1; i < 4_096; i++) {f.advance(1); await f.open(`note-${i}`);}
    await f.open("new", "other-workspace");
    expect(f.prepare).toHaveBeenCalledTimes(4_097);
    await f.open("running");
    await f.open("note-2");
    expect(f.prepare).toHaveBeenCalledTimes(4_097);
    await f.open("note-1");
    expect(f.prepare).toHaveBeenCalledTimes(4_098);
  } finally {release(); await pending;}
});

it("refuses a new key when every admission entry is still running", async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  f.prepare.mockImplementation(async () => {await held; return {kind: "busy"};});
  const pending = Array.from({length: 4_096}, (_, i) => f.open(`note-${i}`));
  try {
    expect(f.prepare).toHaveBeenCalledTimes(4_096);
    expect(await f.open("new", "other-workspace")).toMatchObject({kind: "unavailable", reason: "busy"});
    expect(f.blob).toHaveBeenCalledTimes(4_096);
    expect(f.prepare).toHaveBeenCalledTimes(4_096);
  } finally {release(); await Promise.all(pending);}
});
