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
  /** The note's path when it paused. */
  readonly path: string;
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
  /** "ended" when the note's file was moved, deleted or replaced, or its lineage ended. */
  readonly cause: "refused" | "failing" | "ended";
  /** The people whose edits were in the refused save. */
  readonly names: string[];
  /** Null when the copy was written before this desktop started and can't be named. */
  readonly copyPath: string | null;
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

async function relayCopy(
  relay: OwnerLivePauseRelay,
  pause: RelayLivePause,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const bytes = await relay.copy(pause, signal);
  if (createHash("sha256").update(bytes).digest("hex") !== pause.copy?.sha256)
    throw new Error("The server's copy of the paused note changed while it was read.");
  return bytes;
}

/**
 * Brings each paused note to rest on this computer and returns what its owner
 * is told. The relay's copy is in a file before the relay is told it may
 * delete its own. A note this computer can still pause is paused by the
 * engine with that copy, so the owner's unsent edits join it. Any other copy,
 * such as one of a note moved or deleted outside dohc, is written as the
 * relay sent it. Each step is recorded before the next, so a pass that ends
 * early continues on the next. A note this pass can't settle yet, such as one
 * whose saves have not all arrived, is tried again on the next pass.
 */
export async function settleOwnerLivePauses(input: {
  pauses: readonly RelayLivePause[];
  /** What the last pass told the owner, which names the copies it wrote. */
  previous: readonly OwnerLivePause[];
  documents: readonly ListedOwnerDeliveryDocument[];
  client: Pick<
    EngineClient,
    | "ownerYDocPause"
    | "ownerYDocPausedCopy"
    | "ownerYDocPausedCopyWritten"
    | "ownerYDocStopList"
    | "ownerYDocStopClear"
  >;
  workspaceHandle: string;
  relay: OwnerLivePauseRelay;
  writes: OwnerLivePauseWrites;
  /** The note's Markdown from its whole state. */
  render(state: Uint8Array): Promise<string>;
  signal: AbortSignal;
  onError(pause: RelayLivePause, error: unknown): void;
}): Promise<OwnerLivePause[]> {
  const request = () => ({ id: 0, workspace: input.workspaceHandle, deadlineMs: 30_000 });
  /** Writes a held Stop's copy next to `near` and records it. */
  const writeHeld = async (
    held: NonNullable<Awaited<ReturnType<EngineClient["ownerYDocPausedCopy"]>>>,
    near: string,
  ) => {
    const path = (await input.writes.exists(held.stop.paused.copyPath))
      ? await freeName(near, input.writes)
      : held.stop.paused.copyPath;
    const written = await input.writes.create(path, held.bytes?.toString("utf8") ?? "");
    return (await input.client.ownerYDocPausedCopyWritten(request(), held.stop.document, written))
      .paused;
  };
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
      // Only a pause made here and now holds the relay's copy. A Stop held from
      // before may be an earlier pause's, so the relay's copy then gets a file of its own.
      let joined = false;
      if (!held && listed && pause.copy) {
        await input.client.ownerYDocPause(
          request(),
          {
            binding: listed.binding,
            appliedCursor: pause.savedCursor,
            rowCursor: pause.savedCursor,
            copyPath: await freeName(pause.path, input.writes),
            roomCopy: await relayCopy(input.relay, pause, input.signal),
          },
          input.signal,
        );
        held = await input.client.ownerYDocPausedCopy(request(), document, input.signal);
        if (!held) throw new Error("The paused note's copy is missing.");
        joined = true;
      }
      // After a restart only a Stop paused at this pause's save can name its copy.
      let copy: { copyPath: string | null; leftOut: boolean } | null =
        input.previous.find((told) => told.pauseId === pause.pauseId) ??
        (held?.stop.paused.appliedCursor === pause.savedCursor ? held.stop.paused : null);
      if (held && !held.stop.paused.copyWritten) copy = await writeHeld(held, pause.path);
      if (pause.copy && !joined) {
        const text = await input.render(await relayCopy(input.relay, pause, input.signal));
        copy = {
          copyPath: await input.writes.create(await freeName(pause.path, input.writes), text),
          leftOut: false,
        };
      }
      if (pause.copy) await input.relay.copyWritten(pause.pauseId, pause.copy.sha256, input.signal);
      settled.push({
        pauseId: pause.pauseId,
        objectId: pause.objectId,
        path: pause.path,
        cause: pause.refusal === "stale-binding" ? "ended" : pause.cause,
        names: authorNames(pause.named),
        copyPath: copy?.copyPath ?? null,
        leftOut: copy?.leftOut ?? false,
      });
    } catch (error) {
      input.signal.throwIfAborted();
      input.onError(pause, error);
    }
  }
  // A pause that ended elsewhere, by a Resume on another computer or one cut
  // short here, leaves this computer's Stop behind. Its copy goes on disk,
  // then clearing it lets the note join its room again.
  const paused = new Set(input.pauses.map((pause) => pause.objectId));
  try {
    for (const stop of await input.client.ownerYDocStopList(request(), input.signal)) {
      if (!stop.paused || paused.has(stop.document.objectId)) continue;
      if (!stop.paused.copyWritten) {
        const held = await input.client.ownerYDocPausedCopy(request(), stop.document, input.signal);
        if (held && !held.stop.paused.copyWritten) await writeHeld(held, stop.document.currentPath);
      }
      await input.client.ownerYDocStopClear(request(), stop.document, input.signal);
    }
  } catch (error) {
    input.signal.throwIfAborted();
    console.error("[desktop] a resumed note's Stop could not be cleared:", error);
  }
  return settled;
}
