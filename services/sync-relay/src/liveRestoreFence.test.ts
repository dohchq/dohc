import {expect, it} from "vitest";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {parseNativeRestoreRefusal, type NativeRestoreFence} from "./liveRestoreFence";

const operation: NativeRestoreFence = {
  point: {journalCursor: 0, receiptDigest: "a".repeat(64)},
  operationId: "restore", relayDatabaseNamespace: "relay", hostId: "host",
  oldBinding: {workspaceId: "workspace", mainVersionId: "main", objectId: "note",
    lineageClaimId: "a".repeat(64), currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1},
  newFence: 2, origin: {kind: "bootstrap", id: "bootstrap"}, terminal: null, appliedSequence: 0,
};

it.each(["binding-changed", "reader-unavailable", "source-unavailable", "source-too-large", "incomplete-witness"])(
  "accepts only an identified pre-fence refusal: %s", reason => {
    const refusal = {operation: structuredClone(operation), reason};
    expect(parseNativeRestoreRefusal(refusal, operation)).toEqual(refusal);
    const parsed = parseNativeRestoreRefusal(refusal, operation);
    parsed.operation.oldBinding = {...parsed.operation.oldBinding, selectorPaths: ["a.md", "other"]};
    expect(refusal.operation.oldBinding.selectorPaths).toEqual(["a.md"]);
  });

it.each(["interrupted", "timeout", "disconnected", "conflict", "unknown", "publication-pending"])(
  "does not turn %s into an abandonable refusal", reason => {
    expect(() => parseNativeRestoreRefusal({operation, reason}, operation)).toThrow();
  });

it.each([
  (value: NativeRestoreFence) => {value.operationId = "another";},
  (value: NativeRestoreFence) => {value.relayDatabaseNamespace = "another";},
  (value: NativeRestoreFence) => {value.hostId = "another";},
  (value: NativeRestoreFence) => {value.oldBinding = {...value.oldBinding, objectId: "another"};},
  (value: NativeRestoreFence) => {value.oldBinding = {...value.oldBinding, selectorPaths: ["a.md", "other"]};},
  (value: NativeRestoreFence) => {value.oldBinding = {...value.oldBinding, selectorPaths: ["a.md", "a.md"]};},
  (value: NativeRestoreFence) => {value.oldBinding = {...value.oldBinding, restoreFenceGeneration: value.oldBinding.restoreFenceGeneration + 1}; value.newFence++;},
  (value: NativeRestoreFence) => {value.origin.id = "another";},
  (value: NativeRestoreFence) => {value.point.receiptDigest = "b".repeat(64);},
  (value: NativeRestoreFence) => {value.appliedSequence++;},
  (value: NativeRestoreFence) => {value.terminal = {deliveryId: "delivery", updateDigest: "b".repeat(64), journalCursor: 1, acceptingHostEpoch: parseHostEpoch(1)};},
])("refuses another operation's identity %#", mutate => {
  const altered = structuredClone(operation); mutate(altered);
  expect(() => parseNativeRestoreRefusal({operation: altered, reason: "binding-changed"}, operation)).toThrow();
});

it.each([
  null, new Error("unknown"), {code: "native-restore-refused"},
  {operation, reason: "binding-changed", committed: false},
  {operation, reason: "binding-changed", receipt: {}},
  {operation}, {reason: "binding-changed"},
  {operation: {...operation, extra: true}, reason: "binding-changed"},
])("refuses ambiguous and malformed answers %#", value => {
  expect(() => parseNativeRestoreRefusal(value, operation)).toThrow();
});
