import { createHash } from "node:crypto";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import type { ListedOwnerDeliveryDocument } from "./serverOwnerDelivery";

/** One note the relay paused, as its owner's `live-pauses` list names it. */
export interface RelayLivePause {
  readonly pauseId: string;
  readonly objectId: string;
  readonly lineageClaimId: string;
  readonly savedCursor: number;
  readonly cause: "refused" | "failing";
  readonly refusal: string | null;
  readonly named: readonly LiveAuthorSnapshot[];
  /** Null once this desktop wrote the copy and the relay deleted its own. */
  readonly copy: { readonly sha256: string; readonly byteLength: number } | null;
}

/** What the owner is told about a paused note. */
export interface OwnerLivePause {
  readonly pauseId: string;
  readonly objectId: string;
  readonly path: string;
  /** "moved" when the note's file was moved or deleted outside dohc. */
  readonly cause: "refused" | "failing" | "moved";
  /** The people whose edits were in the refused save. */
  readonly names: string[];
  readonly copyPath: string;
  /** Some edits could not be shown as text, so the copy leaves them out. */
  readonly leftOut: boolean;
}

export interface OwnerLivePauseRelay {
  copy(pause: RelayLivePause, signal: AbortSignal): Promise<Uint8Array>;
  copyWritten(pauseId: string, sha256: string, signal: AbortSignal): Promise<void>;
}

export interface OwnerLivePauseWrites {
  exists(path: string): Promise<boolean>;
  /** Writes a new file and returns its path. */
  create(path: string, text: string): Promise<string>;
}

const MAX_NAME_ATTEMPTS = 100;

export function unsavedEditsName(path: string, attempt: number): string {
  const slash = path.lastIndexOf("/"),
    dot = path.lastIndexOf(".");
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  return `${stem} (unsaved edits${attempt === 1 ? "" : ` ${attempt}`})${ext}`;
}

async function freeName(path: string, writes: OwnerLivePauseWrites): Promise<string> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const name = unsavedEditsName(path, attempt);
    if (!(await writes.exists(name))) return name;
  }
  throw new Error(
    "dohc could not find a free name for the paused note's copy. Rename older copies, then try again.",
  );
}

function authorNames(named: readonly LiveAuthorSnapshot[]): string[] {
  const names = new Set<string>();
  for (const entry of named.flat()) {
    if (entry.kind === "human") names.add(entry.humanName);
    else if (entry.kind === "link") names.add(entry.label);
    else if (entry.kind === "agent" && entry.agentName) names.add(entry.agentName);
    else if (entry.kind === "automation" && entry.attribution.run)
      names.add(entry.attribution.run.automationName);
  }
  return [...names];
}

/**
 * Brings each paused note to rest on this computer: the engine pauses it with
 * the relay's copy of the room, the copy is written next to the note, and the
 * relay deletes its own. Each step is recorded before the next, so a pass that
 * ends early continues on the next. A note this pass can't settle yet, such
 * as one whose saves have not all arrived, is tried again on the next pass.
 */
export async function settleOwnerLivePauses(input: {
  pauses: readonly RelayLivePause[];
  documents: readonly ListedOwnerDeliveryDocument[];
  client: Pick<EngineClient, "ownerYDocPause" | "ownerYDocPausedCopy" | "ownerYDocPausedCopyWritten">;
  workspaceHandle: string;
  relay: OwnerLivePauseRelay;
  writes: OwnerLivePauseWrites;
  signal: AbortSignal;
  onError(pause: RelayLivePause, error: unknown): void;
}): Promise<OwnerLivePause[]> {
  const request = () => ({ id: 0, workspace: input.workspaceHandle, deadlineMs: 30_000 });
  const settled: OwnerLivePause[] = [];
  for (const pause of input.pauses) {
    input.signal.throwIfAborted();
    const listed = input.documents.find(
      (document) =>
        document.binding.objectId === pause.objectId &&
        document.binding.lineageClaimId === pause.lineageClaimId,
    );
    const document = { mainVersionId: "main", objectId: pause.objectId };
    try {
      let held = await input.client.ownerYDocPausedCopy(request(), document, input.signal);
      if (!held) {
        // The engine needs the note's binding and the room's copy to pause it.
        if (!listed || !pause.copy) continue;
        const roomCopy = await input.relay.copy(pause, input.signal);
        if (createHash("sha256").update(roomCopy).digest("hex") !== pause.copy.sha256)
          throw new Error("The server's copy of the paused note changed while it was read.");
        await input.client.ownerYDocPause(
          request(),
          {
            binding: listed.binding,
            appliedCursor: pause.savedCursor,
            rowCursor: pause.savedCursor,
            copyPath: await freeName(listed.binding.currentPath, input.writes),
            roomCopy,
          },
          input.signal,
        );
        held = await input.client.ownerYDocPausedCopy(request(), document, input.signal);
        if (!held) throw new Error("The paused note's copy is missing.");
      }
      let { paused } = held.stop;
      if (!paused.copyWritten) {
        const path = (await input.writes.exists(paused.copyPath))
          ? await freeName(held.stop.document.currentPath, input.writes)
          : paused.copyPath;
        const written = await input.writes.create(path, held.bytes?.toString("utf8") ?? "");
        paused = (await input.client.ownerYDocPausedCopyWritten(request(), document, written))
          .paused;
      }
      if (pause.copy) await input.relay.copyWritten(pause.pauseId, pause.copy.sha256, input.signal);
      settled.push({
        pauseId: pause.pauseId,
        objectId: pause.objectId,
        path: held.stop.document.currentPath,
        cause: pause.refusal === "stale-binding" ? "moved" : pause.cause,
        names: authorNames(pause.named),
        copyPath: paused.copyPath,
        leftOut: paused.leftOut,
      });
    } catch (error) {
      input.signal.throwIfAborted();
      input.onError(pause, error);
    }
  }
  return settled;
}
