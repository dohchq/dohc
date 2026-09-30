import type {
  AutomationPressOutcome,
  RelayAutomationPress,
} from "@dohc/workspace-contracts/relay";
import type { CollectionAutomationPress, PressSettled } from "./collectionAutomations";

// Button presses from shared views (ADR 0012). A recipient's computer sends
// the press to the relay; the automation host, one of the owner's computers
// or the server, takes it here as the pressing person's press, and tells the
// relay how it ended. A failure also reaches the person who pressed as a
// notice.

// After a failed request the loop waits this long, doubling to the cap.
const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const ERROR_MAX_CHARS = 1_000;

/**
 * The relay's press routes for one workspace, as its host calls them: over
 * HTTP from a computer, in process on the server.
 */
export interface PressTransport {
  /** The presses this host has not settled, waiting a while for one when there are none. */
  list(signal: AbortSignal): Promise<RelayAutomationPress[]>;
  /** Accepts presses at the host generation this host read; answers the ones accepted. */
  accept(generation: number, hostPressIds: string[]): Promise<string[]>;
  settle(input: { hostPressId: string; outcome: AutomationPressOutcome; error: string | null }): Promise<void>;
}

/** How a relayed press ended, for the person who pressed it. */
export interface RelayedPressFailure {
  press: RelayAutomationPress;
  /** The button's name when the host knew it. */
  field: string | null;
  outcome: "failed" | "busy";
  error: string | null;
}

/** The notice a relayed press's failure sends the person who pressed it. */
export function relayedPressFailureNotice({ press, field, outcome, error }: RelayedPressFailure) {
  const button = (field ?? "A button").slice(0, 80);
  const { collectionPath } = press;
  return {
    noticeId: `automation-press:${press.hostPressId}`,
    kind: "automation-failed" as const,
    title: outcome === "busy" ? `${button} did not run` : `${button} did not finish`,
    body: (outcome === "busy"
      ? "It was already running on this record for someone else. Press it again when that run finishes."
      : error ?? "The automation failed.").slice(0, 500),
    target: { path: collectionPath, record: press.recordId, automation: press.automationId },
    recipientUserId: press.pressedBy,
  };
}

/**
 * Whether this host runs the workspace's automations, as the one automation
 * host module decides (item 10). The relayed press loop asks only through
 * this, so the host module stays the only code that claims or hands over.
 */
export interface PressHostSeam {
  /** A fresh read, which claims the host when none is recorded. */
  runsHere(): Promise<boolean>;
  /** Answered at once from the last read, right before acting. */
  stillRuns(): boolean;
  /** The host generation this host runs at, or null when it does not. */
  generation(): number | null;
  /**
   * Holds off a handover while a press is accepted and pressed: null when this host
   * no longer runs the workspace's automations or a handover has begun.
   */
  hold(): (() => void) | null;
}

/** An engine press's claim this host already holds for a relayed press, or null. */
export type HeldClaim = { claimId: string; settled: Omit<PressSettled, "claimId"> | null } | null;

export interface RelayedPressHostOptions {
  workspaceId: string;
  host: PressHostSeam;
  /** The relay's press routes, or null when this host cannot reach them as the owner. */
  transport(): Promise<PressTransport | null>;
  /** The claim the engine already holds for this press, found without making one. */
  heldClaim(press: RelayAutomationPress): Promise<HeldClaim>;
  press(
    input: { automationId: string; collectionPath: string; definitionHash: string; recordId: string; pressId: string; pressedBy: string },
    watch: (claimId: string) => void,
  ): Promise<{ pressed: CollectionAutomationPress; field: string | null }>;
  notifyFailure(failure: RelayedPressFailure): Promise<void>;
  onError(context: string, error: unknown): void;
  /** Waits before a retry; a test drives it. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function errorText(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim().slice(0, ERROR_MAX_CHARS);
  return message.length > 0 ? message : "The button did not finish.";
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * The host's side for one open workspace. It runs only while the host module
 * says this host runs the workspace's automations. A press is accepted
 * and pressed under a hold, so a handover waits for it; its run then holds
 * the host itself through the executor. After a restart, a press resumes
 * only when its engine claim already exists; otherwise the relay checks its
 * grant again before it runs.
 */
export function createRelayedPressHost(options: RelayedPressHostOptions) {
  const { host } = options;
  const delay = options.delay ?? wait;
  let running: AbortController | null = null;
  // Presses this host has pressed, by claim, until their runs settle.
  const byClaim = new Map<string, { press: RelayAutomationPress; field: string | null }>();
  // Presses taken this session, so a list naming them again does not press twice.
  const taken = new Set<string>();
  // Settles the relay has not taken yet; each loop sends them first.
  const unsent = new Map<string, { hostPressId: string; outcome: AutomationPressOutcome; error: string | null }>();

  async function settle(relay: PressTransport, input: { hostPressId: string; outcome: AutomationPressOutcome; error: string | null }): Promise<void> {
    unsent.set(input.hostPressId, input);
    await relay.settle(input);
    unsent.delete(input.hostPressId);
    // The relay stops listing a settled press, so this session forgets it too.
    taken.delete(input.hostPressId);
  }

  async function ended(relay: PressTransport, press: RelayAutomationPress, field: string | null, outcome: AutomationPressOutcome, error: string | null) {
    try {
      await settle(relay, { hostPressId: press.hostPressId, outcome, error });
    } catch (settleError) {
      options.onError(`settle relayed press "${press.hostPressId}"`, settleError);
    }
    if (outcome === "failed" || outcome === "busy") {
      await options.notifyFailure({ press, field, outcome, error }).catch((notifyError: unknown) =>
        options.onError(`tell the person who pressed "${press.hostPressId}"`, notifyError));
    }
  }

  // Follows a claim the engine held before this session until its run settles.
  async function resume(relay: PressTransport, press: RelayAutomationPress, held: NonNullable<HeldClaim>): Promise<void> {
    let settled = held.settled;
    if (settled === null) {
      if (byClaim.has(held.claimId)) return;
      const entry = { press, field: null };
      byClaim.set(held.claimId, entry);
      // A restarted executor can settle the claim while the lookup runs, and
      // that end found no entry, so look once more now that one exists.
      try {
        settled = (await options.heldClaim(press))?.settled ?? null;
      } catch (error) {
        // Forgotten, so the next list takes the press again instead of losing its settle.
        if (byClaim.get(held.claimId) === entry) {
          byClaim.delete(held.claimId);
          taken.delete(press.hostPressId);
        }
        throw error;
      }
      if (settled === null || !byClaim.delete(held.claimId)) return;
    }
    await ended(relay, press, null, settled.outcome, settled.error);
  }

  async function take(relay: PressTransport, press: RelayAutomationPress): Promise<void> {
    if (taken.has(press.hostPressId)) return;
    if (press.state === "accepted") {
      // After a restart: a press whose claim the engine holds resumes as it is.
      const held = await options.heldClaim(press);
      if (held !== null) {
        taken.add(press.hostPressId);
        await resume(relay, press, held);
        return;
      }
    }
    // Held from the accept until the press returns, so a handover waits for
    // the admission and nothing is accepted once one begins.
    const release = host.hold();
    if (release === null) return;
    try {
      const generation = host.generation();
      if (generation === null || !host.stillRuns()) return;
      // The relay checks the grant again here, including for a press this
      // host accepted before a restart, so an ended grant runs nothing.
      const accepted = await relay.accept(generation, [press.hostPressId]);
      if (!accepted.includes(press.hostPressId) || !host.stillRuns()) return;
      taken.add(press.hostPressId);
      let result: Awaited<ReturnType<RelayedPressHostOptions["press"]>>;
      try {
        result = await options.press(
          {
            automationId: press.automationId, collectionPath: press.collectionPath, definitionHash: press.definitionHash, recordId: press.recordId,
            pressId: press.hostPressId, pressedBy: press.pressedBy,
          },
          // Watched before its run can start, so a run that settles at once is still told.
          (claimId) => byClaim.set(claimId, { press, field: null }),
        );
      } catch (error) {
        await ended(relay, press, null, "failed", errorText(error));
        return;
      }
      const { pressed, field } = result;
      if (pressed.busy) {
        await ended(relay, press, field, "busy", null);
        return;
      }
      if (pressed.settled) {
        await ended(relay, press, field, pressed.settled.outcome, pressed.settled.error);
        return;
      }
      // Gone already when its run settled first.
      const watched = byClaim.get(pressed.claimId);
      if (watched) watched.field = field;
    } finally {
      release();
    }
  }

  async function loop(signal: AbortSignal): Promise<void> {
    let retryMs = RETRY_FIRST_MS;
    while (!signal.aborted) {
      try {
        if (!(await host.runsHere())) return;
        const relay = await options.transport();
        if (relay === null) return;
        for (const input of [...unsent.values()]) await settle(relay, input);
        const presses = await relay.list(signal);
        for (const press of presses) {
          if (signal.aborted) return;
          await take(relay, press);
        }
        retryMs = RETRY_FIRST_MS;
      } catch (error) {
        if (signal.aborted) return;
        options.onError("take relayed Button presses", error);
        await delay(retryMs, signal);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }
  }

  return {
    /** Starts the loop when it is not running. Safe to call at every open and reconnect. */
    start(): void {
      if (running !== null) return;
      const controller = new AbortController();
      running = controller;
      void loop(controller.signal).finally(() => {
        if (running === controller) running = null;
      });
    },

    /** A run this host holds for a relayed press settled. */
    runSettled(event: PressSettled): void {
      const found = byClaim.get(event.claimId);
      if (!found) return;
      byClaim.delete(event.claimId);
      void options.transport().then((relay) => {
        if (relay === null) {
          unsent.set(found.press.hostPressId, { hostPressId: found.press.hostPressId, outcome: event.outcome, error: event.error });
          return;
        }
        return ended(relay, found.press, found.field, event.outcome, event.error);
      }).catch((error: unknown) => options.onError(`settle relayed press "${found.press.hostPressId}"`, error));
    },

    /** The workspace closed. A later open finds each press again through its engine claim. */
    stop(): void {
      running?.abort();
      running = null;
      byClaim.clear();
      taken.clear();
    },
  };
}

export type RelayedPressHost = ReturnType<typeof createRelayedPressHost>;
