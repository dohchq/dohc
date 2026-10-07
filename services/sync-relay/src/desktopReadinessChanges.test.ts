import {expect, it, vi} from "vitest";
import {notifyDesktopReadiness, observeDesktopReadiness} from "./desktopReadinessChanges";
import {notifyRelayWrite} from "./relayWriteChanges";
import {fixture, binding, host, scope} from "./liveTickets.test-helper";
import type {LiveDocumentBaselineRegistrationInput} from "./storage";
import type {StorageContext} from "./storage/context";

it("routes share and path changes without waking other waits or following global writes", async () => {
  const storage = {}, first = vi.fn(), second = vi.fn(), otherStorage = vi.fn();
  const stops = [
    observeDesktopReadiness(storage, {shareId: "first", workspaceId: "workspace", path: "docs/a.md"}, first),
    observeDesktopReadiness(storage, {shareId: "second", workspaceId: "workspace", path: "docs/b.md"}, second),
    observeDesktopReadiness({}, {shareId: "first", workspaceId: "workspace", path: "docs/a.md"}, otherStorage),
  ];
  notifyRelayWrite(storage);
  notifyDesktopReadiness(storage, {workspaceId: "workspace", path: "docs/a.md"});
  await new Promise<void>(queueMicrotask);
  expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled(); expect(otherStorage).not.toHaveBeenCalled();
  notifyDesktopReadiness(storage, {shareId: "second"});
  await new Promise<void>(queueMicrotask);
  expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
  notifyDesktopReadiness(storage, {shareId: "first"});
  stops.forEach(stop => stop());
  await new Promise<void>(queueMicrotask);
  expect(first).toHaveBeenCalledOnce();
});

it("wakes baseline waits from validated registration, refusals and transaction errors, but ignores malformed input", async () => {
  const f = await fixture(), changed = vi.fn();
  const stop = observeDesktopReadiness(f.storage, {...scope, path: binding.currentPath}, changed);
  const input: LiveDocumentBaselineRegistrationInput = {
    host, baselineBytes: new Uint8Array([0, 0]), registeredAtMs: 10,
    evidence: {version: 1, document: {workspaceId: binding.workspaceId, mainVersionId: "main",
      objectId: binding.objectId, lineageClaimId: binding.lineageClaimId}, currentPath: binding.currentPath,
      checkpoint: {updateDigest: binding.lineageClaimId, ranges: []},
      projectedMarkdownSha256: "b".repeat(64), projectedMarkdownByteLength: 1},
  };
  try {
    const hostile = vi.fn(() => { throw new Error("hostile accessor"); });
    const malformed: unknown[] = [null,
      Object.defineProperty({...input}, "evidence", {get: hostile}),
      {...input, evidence: Object.defineProperty({...input.evidence}, "document", {get: hostile})},
      new Proxy(input, {get: hostile, getOwnPropertyDescriptor: hostile}),
    ];
    for (const bad of malformed) {
      expect(f.storage.registerLiveDocumentBaseline(bad as LiveDocumentBaselineRegistrationInput))
        .toEqual({kind: "refused", reason: "invalid-baseline"});
    }
    await new Promise<void>(queueMicrotask);
    expect(hostile).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();

    expect(f.storage.registerLiveDocumentBaseline(input)).toMatchObject({kind: "registered"});
    await new Promise<void>(queueMicrotask);
    expect(changed).toHaveBeenCalledTimes(1);

    expect(f.storage.registerLiveDocumentBaseline({...input, host: {...host, connectionId: "stale"}}))
      .toEqual({kind: "refused", reason: "stale-host"});
    await new Promise<void>(queueMicrotask);
    expect(changed).toHaveBeenCalledTimes(2);

    const badHost = Object.defineProperty({...host}, "hostId", {get: hostile});
    expect(f.storage.registerLiveDocumentBaseline({...input, host: badHost}))
      .toEqual({kind: "refused", reason: "stale-host"});
    await new Promise<void>(queueMicrotask);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(hostile).not.toHaveBeenCalled();

    const transaction = vi.spyOn(f.storage as StorageContext, "tx").mockImplementationOnce(() => { throw new Error("transaction fault"); });
    try {
      expect(() => f.storage.registerLiveDocumentBaseline(input)).toThrow("transaction fault");
      await new Promise<void>(queueMicrotask);
      expect(changed).toHaveBeenCalledTimes(4);
    } finally { transaction.mockRestore(); }
  } finally { stop(); await f.close(); }
});
