import {firstOpenRefusal, firstOpenReport, type FirstOpenOutcome, type FirstOpenReason, type FirstOpenRefusal,
  type FirstOpenSourceIdentity} from "@dohc/workspace-contracts/first-open";

/** What a remembered answer depends on besides its source. */
export interface FirstOpenAnswerContext {
  /** The checks that decide whether a file can go live, such as the validation policy. A refusal under other checks holds nothing. */
  readonly policy: string;
  /** The bounds a base must fit. A `too-large` refusal under other bounds holds nothing. */
  readonly bounds: string;
}

/**
 * How long each answer holds. `document`: the document's history decided it,
 * so it holds for every later source: a base, earlier live authority, a
 * deletion or a refused activation of the base. `source`: the file's bytes
 * decided it, so it holds for the same bytes at the same path, whatever moment
 * carries them. Null: it holds nothing; a stale source or a failure that can
 * pass never stops a later request.
 */
const HOLDS = {
  "published": "document", "replayed": "document", "prior-authority": "document", "deletion": "document", "ordinary-activation-refused": "document",
  "unsupported-source": "source", "too-large": "source", "integrity": "source",
  "stale-source": null, "unavailable": null,
} as const satisfies Record<FirstOpenReason, "document" | "source" | null>;

/** How many documents' answers a host keeps. Full, it forgets the one it heard longest ago, which costs one more request. */
const FIRST_OPEN_ANSWERS = 4_096;

interface Held {
  readonly outcome: FirstOpenOutcome;
  readonly context: FirstOpenAnswerContext;
  /** The owner's Try again: requests go through until an answer that holds arrives. */
  retry: boolean;
}
const documentKey = (document: {workspaceId: string; objectId: string}) => JSON.stringify([document.workspaceId, document.objectId]);

/**
 * The relay's standing first-open answer for each document a host asks about,
 * so it asks again only once something that decided the answer changed. A
 * restart forgets every answer; the relay's history answers the next request.
 */
export class FirstOpenAnswers {
  readonly #held = new Map<string, Held>();
  constructor(readonly maxDocuments = FIRST_OPEN_ANSWERS) {}

  /** Keeps an answer that holds, which ends a Try again. One that holds nothing leaves the earlier answer, and a Try again, as they were. */
  record(outcome: FirstOpenOutcome, context: FirstOpenAnswerContext) {
    if (HOLDS[firstOpenReport(outcome).reason] === null) return;
    const key = documentKey(outcome.source);
    this.#held.delete(key);
    this.#held.set(key, {outcome, context, retry: false});
    if (this.#held.size > this.maxDocuments) this.#held.delete(this.#held.keys().next().value!);
  }

  /** The answer that still holds for the source, or undefined to ask the relay now. */
  standing(source: FirstOpenSourceIdentity, context: FirstOpenAnswerContext): FirstOpenOutcome | undefined {
    const held = this.#holding(source, context);
    return held && !held.retry ? held.outcome : undefined;
  }

  /** The refusal the owner sees for the document's current source, unless a Try again is still waiting for an answer that holds. */
  refusal(source: FirstOpenSourceIdentity, context: FirstOpenAnswerContext): FirstOpenRefusal | undefined {
    const held = this.#holding(source, context);
    return held && !held.retry ? firstOpenRefusal(held.outcome) : undefined;
  }

  /** Whether the document has an answer, so a caller reads its current source only then. */
  has(document: {workspaceId: string; objectId: string}): boolean {return this.#held.has(documentKey(document));}

  /** Forgets the document's answer, as once it went live or left this host. */
  forget(document: {workspaceId: string; objectId: string}) {this.#held.delete(documentKey(document));}

  /**
   * Lets requests for a refused document through until an answer that holds
   * arrives, as its owner's Try again, so a failure that can pass never
   * brings the old refusal back unchecked. Returns whether a refusal stood.
   */
  retry(document: {workspaceId: string; objectId: string}): boolean {
    const held = this.#held.get(documentKey(document));
    if (!held || !firstOpenRefusal(held.outcome)) return false;
    held.retry = true;
    return true;
  }

  #holding(source: FirstOpenSourceIdentity, context: FirstOpenAnswerContext): Held | undefined {
    const held = this.#held.get(documentKey(source));
    if (!held) return undefined;
    const {outcome} = held, holds = HOLDS[firstOpenReport(outcome).reason];
    if (holds === "document") return held;
    if (outcome.source.path !== source.path || outcome.source.sourceDigest !== source.sourceDigest) return undefined;
    const tooLarge = outcome.kind === "refused" && outcome.reason === "too-large";
    return (tooLarge ? held.context.bounds === context.bounds : held.context.policy === context.policy) ? held : undefined;
  }
}
