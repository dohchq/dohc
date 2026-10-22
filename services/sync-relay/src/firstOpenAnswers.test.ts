import {expect, it} from "vitest";
import {FIRST_OPEN_TOO_LARGE_CODES, FIRST_OPEN_UNSUPPORTED_CAUSES, firstOpenOutcome, type FirstOpenSourceIdentity} from "@dohc/workspace-contracts/first-open";
import {FirstOpenAnswers} from "./firstOpenAnswers";

type Answer = Parameters<typeof firstOpenOutcome>[1];
const SOURCE: FirstOpenSourceIdentity = {workspaceId: "workspace-1", objectId: "object-1", path: "docs/a.md", sourceMomentId: "moment-1", sourceDigest: "a".repeat(64)};
const CONTEXT = {policy: "policy-1", bounds: "bounds-1"};
const receipt = {originId: "service-host:first-open:origin", originSeq: 0, relaySeq: 2} as const;
const answered = (answer: Answer, source = SOURCE, context = CONTEXT, answers = new FirstOpenAnswers()) => {
  answers.record(firstOpenOutcome(source, answer), context);
  return answers;
};
// What the host sees later: the same bytes in a new moment, an edit, a rename, and another document or workspace.
const NEW_MOMENT = {...SOURCE, sourceMomentId: "moment-2"};
const EDITED = {...SOURCE, sourceMomentId: "moment-3", sourceDigest: "b".repeat(64)};
const RENAMED = {...SOURCE, sourceMomentId: "moment-4", path: "docs/b.md"};
const OTHER_DOCUMENT = {...SOURCE, objectId: "object-2"};
const OTHER_WORKSPACE = {...SOURCE, workspaceId: "workspace-2"};

const BYTE_REFUSALS: Answer[] = [
  ...FIRST_OPEN_UNSUPPORTED_CAUSES.map(cause => ({kind: "refused", reason: "unsupported-source", cause}) as const),
  ...FIRST_OPEN_TOO_LARGE_CODES.map(code => ({kind: "refused", reason: "too-large", code}) as const),
  {kind: "integrity", reason: "source-evidence"},
];
// Proves: a refusal of a file's bytes holds for those bytes at that path in any
// moment, so a new moment with identical bytes asks nothing. Changed bytes, a
// rename, another document or another workspace asks again.
it.each(BYTE_REFUSALS.map(answer => [JSON.stringify(answer), answer] as const))("holds %s for the same bytes in a new moment, and only for them", (_, answer) => {
  const answers = answered(answer);
  expect(answers.standing(SOURCE, CONTEXT)).toMatchObject(answer);
  expect(answers.standing(NEW_MOMENT, CONTEXT)).toMatchObject(answer);
  expect(answers.refusal(NEW_MOMENT, CONTEXT)).toMatchObject({source: SOURCE});
  for (const other of [EDITED, RENAMED, OTHER_DOCUMENT, OTHER_WORKSPACE]) {
    expect(answers.standing(other, CONTEXT)).toBeUndefined();
    expect(answers.refusal(other, CONTEXT)).toBeUndefined();
  }
});

// Proves: a too-large refusal holds only under the bounds that refused it, and
// names the bound that failed. A refusal of the file's content holds only under
// the checks that refused it, so changed checks ask again. Neither moves with
// the other.
it("keys a too-large refusal by its bounds and a content refusal by its checks", () => {
  for (const code of FIRST_OPEN_TOO_LARGE_CODES) {
    const answers = answered({kind: "refused", reason: "too-large", code});
    expect(answers.refusal(SOURCE, {...CONTEXT, policy: "policy-2"})).toMatchObject({reason: "too-large", code});
    expect(answers.standing(SOURCE, {...CONTEXT, bounds: "bounds-2"})).toBeUndefined();
    expect(answers.refusal(SOURCE, {...CONTEXT, bounds: "bounds-2"})).toBeUndefined();
  }
  for (const cause of FIRST_OPEN_UNSUPPORTED_CAUSES) {
    const answers = answered({kind: "refused", reason: "unsupported-source", cause});
    expect(answers.refusal(SOURCE, {...CONTEXT, bounds: "bounds-2"})).toMatchObject({reason: "unsupported-source", code: cause});
    expect(answers.standing(SOURCE, {...CONTEXT, policy: "policy-2"})).toBeUndefined();
  }
  // Raising one bound after another refusal asks once and keeps the newer answer.
  const answers = answered({kind: "refused", reason: "too-large", code: "capture-budget"});
  answers.record(firstOpenOutcome(SOURCE, {kind: "refused", reason: "too-large", code: "read-budget"}), {...CONTEXT, bounds: "bounds-2"});
  expect(answers.standing(SOURCE, CONTEXT)).toBeUndefined();
  expect(answers.refusal(SOURCE, {...CONTEXT, bounds: "bounds-2"})).toMatchObject({code: "read-budget"});
});

const HISTORY: Answer[] = [
  {kind: "published", receipt}, {kind: "replayed", receipt}, {kind: "existing-history", reason: "prior-authority"},
  {kind: "refused", reason: "deletion"}, {kind: "refused", reason: "ordinary-activation-refused", code: "native-disagreement"},
];
// Proves: an answer the document's history decided holds for every later
// source of that document, as after later Y.Doc updates, edits and renames, and
// under other checks and bounds. A published base is never built again, so a
// refused activation of it cannot be evaded by a new seed.
it.each(HISTORY.map(answer => [JSON.stringify(answer), answer] as const))("holds %s for every later source of the document", (_, answer) => {
  const answers = answered(answer);
  for (const later of [SOURCE, NEW_MOMENT, EDITED, RENAMED]) {
    expect(answers.standing(later, {policy: "policy-2", bounds: "bounds-2"})).toMatchObject(answer);
  }
  expect(answers.standing(OTHER_DOCUMENT, CONTEXT)).toBeUndefined();
  expect(answers.standing(OTHER_WORKSPACE, CONTEXT)).toBeUndefined();
  const refusal = answers.refusal(EDITED, CONTEXT);
  if (answer.kind === "refused") expect(refusal).toMatchObject({reason: answer.reason, source: SOURCE});
  else expect(refusal).toBeUndefined();
});

const PASSING: Answer[] = [
  {kind: "refused", reason: "stale-source"},
  ...(["contention", "busy", "reconfigured", "history-unavailable", "worker-failed", "storage-failed", "host-absent", "host-unreachable",
    "check-failed", "check-deadline"] as const).map(reason => ({kind: "unavailable", reason}) as const),
  {kind: "unavailable", reason: "build-deadline", retryAfterMs: 60_000},
];
// Proves: a stale source and every failure that can pass hold nothing: the host
// asks again each time, and nothing reaches the owner. Nor do they lift a
// refusal that stood before.
it.each(PASSING.map(answer => [JSON.stringify(answer), answer] as const))("never holds %s", (_, answer) => {
  const answers = answered(answer);
  for (let attempt = 0; attempt < 3; attempt++) {
    answers.record(firstOpenOutcome(SOURCE, answer), CONTEXT);
    expect(answers.standing(SOURCE, CONTEXT)).toBeUndefined();
    expect(answers.refusal(SOURCE, CONTEXT)).toBeUndefined();
  }
  expect(answers.retry(SOURCE)).toBe(false);
  const refused = answered({kind: "refused", reason: "unsupported-source", cause: "settlement-mismatch"});
  refused.record(firstOpenOutcome(NEW_MOMENT, answer), CONTEXT);
  expect(refused.refusal(SOURCE, CONTEXT)).toMatchObject({reason: "unsupported-source"});
});

// Proves: Try again lets exactly one request through. The owner sees no
// refusal while it waits for an answer, the same refusal stands again after
// it, and a failure that can pass leaves the earlier refusal standing.
it("lets one checked request through for each Try again", () => {
  const refusal: Answer = {kind: "refused", reason: "deletion"};
  const answers = answered(refusal);
  expect(answers.retry({workspaceId: SOURCE.workspaceId, objectId: SOURCE.objectId})).toBe(true);
  expect(answers.refusal(SOURCE, CONTEXT)).toBeUndefined();
  expect(answers.standing(SOURCE, CONTEXT)).toBeUndefined();
  expect(answers.standing(SOURCE, CONTEXT)).toMatchObject(refusal);
  expect(answers.refusal(SOURCE, CONTEXT)).toMatchObject({reason: "deletion"});
  answers.retry(SOURCE);
  expect(answers.standing(SOURCE, CONTEXT)).toBeUndefined();
  answers.record(firstOpenOutcome(SOURCE, {kind: "unavailable", reason: "busy"}), CONTEXT);
  expect(answers.standing(SOURCE, CONTEXT)).toMatchObject(refusal);
  answers.retry(SOURCE);
  answers.standing(SOURCE, CONTEXT);
  answers.record(firstOpenOutcome(SOURCE, refusal), CONTEXT);
  expect(answers.standing(SOURCE, CONTEXT)).toMatchObject(refusal);
  // Nothing to try again for an answer that stops nothing.
  expect(answered({kind: "existing-history", reason: "prior-authority"}).retry(SOURCE)).toBe(false);
  expect(new FirstOpenAnswers().retry(SOURCE)).toBe(false);
});

// Proves: a full host forgets the answer it heard longest ago, which only costs one more request.
it("forgets the oldest document's answer when full", () => {
  const answers = new FirstOpenAnswers(2), refusal: Answer = {kind: "refused", reason: "deletion"};
  for (const objectId of ["object-1", "object-2", "object-3"]) answered(refusal, {...SOURCE, objectId}, CONTEXT, answers);
  expect(answers.standing(SOURCE, CONTEXT)).toBeUndefined();
  expect(answers.standing({...SOURCE, objectId: "object-3"}, CONTEXT)).toMatchObject(refusal);
});
