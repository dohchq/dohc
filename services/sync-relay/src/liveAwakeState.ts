import { isDeepStrictEqual } from "node:util";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { LiveHostRegistration } from "./liveHostRegistration.js";
import type { LiveHostConnectionCoordinate } from "./storage.js";

/** An empty Yjs state vector. The reader holds nothing yet, so the host sends all it applied. */
const EMPTY_VECTOR = new Uint8Array([0]);

/** What a host applied of a note, as an opening sync carries it. */
export interface AwakeLiveState {
  readonly binding: LiveObjectBinding;
  /** The host connection that answered, which a reader checks is still the note's current host. */
  readonly coordinate: LiveHostConnectionCoordinate;
  readonly hostVector: Buffer;
  readonly missingStateUpdate: Buffer;
  readonly appliedThroughJournalCursor: number;
}

/**
 * One read of what the host applied, under a registration the host already holds. The engine queues it with the
 * host's other requests and holds no session lock while it waits. Any failure, or a registration that ends during
 * the read, answers undefined: the reader then opens the note as it would without this state.
 */
export async function readAppliedState(
  host: {
    readonly client: Pick<EngineClient, "openLiveAppliedSync">;
    readonly workspace: string;
    readonly registration: LiveHostRegistration;
    readonly coordinate: LiveHostConnectionCoordinate;
    nextRequestId(): number;
    readonly deadlineMs: number;
  },
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<AwakeLiveState | undefined> {
  const joined = AbortSignal.any([signal, host.registration.invalidated]);
  try {
    const read = await host.client.openLiveAppliedSync(
      {
        id: host.nextRequestId(),
        workspace: host.workspace,
        registrationId: host.registration.id,
        deadlineMs: host.deadlineMs,
      },
      EMPTY_VECTOR,
      { maxInputBytes: EMPTY_VECTOR.byteLength, maxOutputBytes },
      joined,
    );
    if (joined.aborted || !isDeepStrictEqual(read.binding, host.registration.binding))
      return undefined;
    return {
      binding: read.binding,
      coordinate: host.coordinate,
      hostVector: read.hostVector,
      missingStateUpdate: read.missingStateUpdate,
      appliedThroughJournalCursor: read.position.journalCursor,
    };
  } catch {
    return undefined;
  }
}
