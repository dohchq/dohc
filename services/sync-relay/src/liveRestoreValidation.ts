import {createLiveMarkdownRegistrationValidator, WORKER_LIVE_VALIDATION_POLICY} from "@dohc/ydoc-projection/live-journal-validation";
import {resolveLiveRestorePoint, validateLiveRestoreProposal, type LiveRestoreProposalBytes,
  type OrderedLiveUpdateCutPolicy} from "@dohc/ydoc-projection/restore-proof";

type Binding = {workspaceId: string; mainVersionId: string; objectId: string; lineageClaimId: string; currentPath: string};
type Point = {journalCursor: number; receiptDigest: string};
type History = {binding: Binding; checkpoint: Uint8Array; events: readonly Uint8Array[]; point: Point};
type Validated = ReturnType<typeof validateLiveRestoreProposal>;
type Receipt = Parameters<typeof validateLiveRestoreProposal>[0]["receipt"];
type Budget = {maxBytes: number; maxEvents: number};
type ProposalJob = {selected: History; accepted: History; receipt: Receipt; bytes: LiveRestoreProposalBytes; budget: Budget; admission?: boolean};
/** One restore validation: data copied from authenticated captures, never a storage handle or callback. */
type LiveRestoreJob = {mode: "point"; selected: History} | ({mode: "proposal"} & ProposalJob) |
  ({mode: "review"; maxOutputBytes: number} & ProposalJob);
/** A job with the relay's artifact answers so far. An `undefined` answer is an authenticated absence. */
export type LiveRestoreWork = LiveRestoreJob & {answers: ReadonlyMap<string, Uint8Array | undefined>};
export type LiveRestorePoint = ReturnType<typeof resolveLiveRestorePoint>;
export type LiveRestoreReview = ReturnType<Validated["projectReview"]>;
export type LiveRestoreReply = {kind: "point"; point: LiveRestorePoint} |
  {kind: "proposal"; content: Validated["content"]; nativeSourceRanges: Validated["nativeSourceRanges"]; review?: LiveRestoreReview} |
  {kind: "needs-artifact"; digest: string} | {kind: "refused"; message: string} | {kind: "capacity-refused"};
export type LiveRestoreProposalEvidence = {content: Validated["content"]; nativeSourceRanges: Validated["nativeSourceRanges"];
  candidateBytes: Uint8Array; review: LiveRestoreReview | undefined};

class MissingArtifact extends Error {}
/**
 * Runs a restore job in a validation process. A read of an artifact the relay has not answered ends the
 * run, whatever the validation then does, and asks the relay for that digest.
 */
export function runLiveRestoreWork(work: LiveRestoreWork, policy: OrderedLiveUpdateCutPolicy): LiveRestoreReply {
  let missing: string | undefined;
  const artifact = (digest: string) => {
    if (work.answers.has(digest)) return work.answers.get(digest);
    missing ??= digest;
    throw new MissingArtifact();
  };
  // Only the relay can authenticate storage; it checks freshness around every round.
  const assertCurrent = () => {};
  const history = <Target extends "selected" | "accepted">(target: Target, value: History) => ({target, binding: value.binding,
    checkpoint: {bytes: value.checkpoint}, events: value.events.map(updateBytes => ({updateBytes})), point: value.point, assertCurrent});
  let reply: LiveRestoreReply;
  try {
    const selected = {...history("selected", work.selected), artifact};
    if (work.mode === "point") reply = {kind: "point", point: resolveLiveRestorePoint(selected, policy)};
    else {
      const validated = validateLiveRestoreProposal({selected, accepted: history("accepted", work.accepted), receipt: work.receipt,
        assertCurrent}, work.bytes, policy, work.budget);
      if (work.admission) {
        const binding = work.selected.binding;
        const normalized = createLiveMarkdownRegistrationValidator(WORKER_LIVE_VALIDATION_POLICY)({
          document: {workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId,
            objectId: binding.objectId, lineageClaimId: binding.lineageClaimId},
          currentPath: binding.currentPath, checkpoint: validated.content.stateUpdate});
        if (normalized.kind === "refused" && normalized.reason === "capacity-refused") throw new LiveRestoreTooLarge();
      }
      reply = {kind: "proposal", content: {...validated.content}, nativeSourceRanges: validated.nativeSourceRanges,
        ...(work.mode === "review" ? {review: validated.projectReview(work.maxOutputBytes)} : {})};
    }
  } catch (error) {
    reply = error instanceof LiveRestoreTooLarge ? {kind: "capacity-refused"}
      : {kind: "refused", message: error instanceof Error ? error.message : String(error)};
  }
  return missing === undefined ? reply : {kind: "needs-artifact", digest: missing};
}

/** Restore validation cannot start now. The caller may try again later. */
export class LiveRestoreBusy extends Error {}
/** Restore validation ran its validation process out of memory, as the same restore would again. */
export class LiveRestoreTooLarge extends Error {
  constructor() {super("Restore is too large to validate.");}
}
/** At most 15 artifact answers, then the run that uses them. */
const maxExecutions = 16;
type Source = {artifact(digest: string): Uint8Array | undefined; assertCurrent(): void};
type HistoryCapture = {binding: Binding; checkpoint: {bytes: Uint8Array}; events: readonly {updateBytes: Uint8Array}[]; point: Point};
type ProposalCapture = {selected: HistoryCapture & Source; accepted: HistoryCapture; receipt: Receipt; assertCurrent(): void};
export type LiveRestoreRun = (work: LiveRestoreWork, signal?: AbortSignal) =>
  Promise<LiveRestoreReply | {kind: "retry"; waitForCapacity?(signal?: AbortSignal): Promise<void>}>;
const historyData = (capture: HistoryCapture): History => {
  const {workspaceId, mainVersionId, objectId, lineageClaimId, currentPath} = capture.binding;
  return Object.freeze({binding: Object.freeze({workspaceId, mainVersionId, objectId, lineageClaimId, currentPath}),
    checkpoint: capture.checkpoint.bytes, events: Object.freeze(capture.events.map(event => event.updateBytes)),
    point: Object.freeze({journalCursor: capture.point.journalCursor, receiptDigest: capture.point.receiptDigest})});
};

/**
 * Runs restore validation through `run`, answering each artifact the run asks for from the original
 * authenticated capture and resubmitting the same job. One signal, and so one deadline, covers every run.
 */
export function liveRestoreValidator(run: LiveRestoreRun) {
  async function execute(job: LiveRestoreJob, source: Source, signal: AbortSignal | undefined, wait = false) {
    const answers = new Map<string, Uint8Array | undefined>();
    for (let execution = 1; ;) {
      signal?.throwIfAborted();
      const reply = await run({...job, answers}, signal);
      if (reply.kind === "retry") {
        if (!wait || !reply.waitForCapacity) throw new LiveRestoreBusy("Live validation is busy.");
        await reply.waitForCapacity(signal);
        continue;
      }
      if (reply.kind === "capacity-refused") throw new LiveRestoreTooLarge();
      if (reply.kind === "refused") throw new Error(reply.message);
      if (reply.kind !== "needs-artifact") {
        source.assertCurrent();
        return reply;
      }
      if (answers.has(reply.digest)) throw new Error("Restore validation asked again for an answered artifact.");
      if (execution === maxExecutions) throw new Error("Restore validation needs too many artifacts.");
      source.assertCurrent();
      answers.set(reply.digest, source.artifact(reply.digest));
      execution++;
    }
  }
  return Object.freeze({
    async point(capture: HistoryCapture & Source, signal?: AbortSignal): Promise<LiveRestorePoint> {
      const reply = await execute(Object.freeze({mode: "point", selected: historyData(capture)}), capture, signal);
      if (reply.kind !== "point") throw new Error("Restore validation answered another job.");
      return reply.point;
    },
    /** With `maxOutputBytes`, the same run also projects the owner review. */
    async proposal(capture: ProposalCapture, bytes: LiveRestoreProposalBytes, budget: Budget & {maxOutputBytes?: number; admission?: boolean},
      signal?: AbortSignal): Promise<LiveRestoreProposalEvidence> {
      const job: ProposalJob = Object.freeze({selected: historyData(capture.selected), accepted: historyData(capture.accepted),
        receipt: structuredClone(capture.receipt), bytes, budget: Object.freeze({maxBytes: budget.maxBytes, maxEvents: budget.maxEvents}), ...(budget.admission ? {admission: true} : {})});
      const review = budget.maxOutputBytes;
      const reply = await execute(Object.freeze(review === undefined ? {mode: "proposal" as const, ...job} :
        {mode: "review" as const, maxOutputBytes: review, ...job}), {artifact: digest => capture.selected.artifact(digest),
        assertCurrent: () => capture.assertCurrent()}, signal, budget.admission);
      if (reply.kind !== "proposal" || (review !== undefined) !== (reply.review !== undefined)) {
        throw new Error("Restore validation answered another job.");
      }
      return Object.freeze({content: reply.content, nativeSourceRanges: reply.nativeSourceRanges,
        candidateBytes: new Uint8Array(bytes.candidateBytes), review: reply.review});
    },
  });
}
export type LiveRestoreValidator = ReturnType<typeof liveRestoreValidator>;
