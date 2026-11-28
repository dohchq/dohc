import { createHash } from "node:crypto";
import * as Y from "yjs";
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
  readonly lineageClaimId: string;
  readonly path: string;
  /** "ended" when the note's file was moved, deleted or replaced, or its lineage ended. */
  readonly cause: "refused" | "failing" | "ended";
  /** The people whose edits were in the refused save. */
  readonly names: string[];
  /** Null when this desktop hasn't written the copy since it started, so it can't name it. */
  readonly copyPath: string | null;
  /** The copy is known to leave out edits that could not be shown as text. */
  readonly leftOut: boolean;
}

/**
 * The relay holds this note's edits until its owner resumes it, so each row
 * recorded meanwhile becomes a delivery at Resume. An ended pause holds none.
 */
export function holdsDeliveries(pauses: readonly OwnerLivePause[], objectId: string): boolean {
  return pauses.some((pause) => pause.objectId === objectId && pause.cause !== "ended");
}

export function holdsRoom(
  pauses: readonly OwnerLivePause[],
  binding: { readonly objectId: string; readonly lineageClaimId: string },
): boolean {
  return holdsDeliveries(
    pauses.filter((pause) => pause.lineageClaimId === binding.lineageClaimId),
    binding.objectId,
  );
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
  /**
   * The pauses this desktop has asked the engine to make and not yet settled,
   * each with its note and, when the owner typed during it and its copy is
   * not yet written, the state to write the copy from.
   */
  tried: Map<string, { objectId: string; state: Uint8Array | null }>;
  /**
   * Runs `pause` between the edits of the editors open on the note at `path`,
   * given the edits they have not sent. Once it succeeds, they show the note.
   * `late` gets the edits they made while `pause` ran, with the state they
   * build on.
   */
  leaveLiveEditing<T>(
    path: string,
    pause: (unsent: Uint8Array[]) => Promise<T>,
    late: (edits: Uint8Array) => void,
  ): Promise<T>;
  /** The note's file text from its whole state, and whether it leaves some out. */
  render(state: Uint8Array): Promise<{ markdown: string; leftOut: boolean }>;
  signal: AbortSignal;
  onError(pause: RelayLivePause, error: unknown): void;
}): Promise<OwnerLivePause[]> {
  const request = () => ({ id: 0, workspace: input.workspaceHandle, deadlineMs: 30_000 });
  /**
   * Writes a held Stop's copy next to `near` and records it. The owner's typing
   * during its pause never reached the engine, so it joins the copy here.
   */
  const writeHeld = async (
    held: NonNullable<Awaited<ReturnType<EngineClient["ownerYDocPausedCopy"]>>>,
    near: string,
  ) => {
    const objectId = held.stop.document.objectId;
    const late = [...input.tried.values()].find((t) => t.objectId === objectId && t.state)?.state;
    // Rendering may take the bytes it gets, and a retry needs these.
    const withLate = late ? await input.render(late.slice()) : null;
    const path = (await input.writes.exists(held.stop.paused.copyPath))
      ? await freeName(near, input.writes)
      : held.stop.paused.copyPath;
    const written = await input.writes.create(
      path,
      withLate?.markdown ?? held.bytes?.toString("utf8") ?? "",
    );
    const { paused } = await input.client.ownerYDocPausedCopyWritten(
      request(),
      held.stop.document,
      written,
    );
    for (const t of input.tried.values()) if (t.objectId === objectId) t.state = null;
    return withLate?.leftOut ? { ...paused, leftOut: true } : paused;
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
      // Only this pause's Stop holds the relay's copy: one this desktop made for it, now
      // or on a pass whose answer failed after the engine made it. Any other Stop leaves
      // the relay's copy a file of its own.
      let joined = held !== null && !held.stop.paused.copyWritten && input.tried.has(pause.pauseId);
      if (!held && listed && pause.copy) {
        const roomCopy = await relayCopy(input.relay, pause, input.signal);
        const copyPath = await freeName(pause.path, input.writes);
        // No copy of this note is held, so typing kept for an earlier attempt has none to join.
        for (const [id, t] of input.tried)
          if (t.objectId === pause.objectId) input.tried.delete(id);
        const tried = { objectId: pause.objectId, state: null as Uint8Array | null };
        input.tried.set(pause.pauseId, tried);
        let paused = roomCopy;
        const late: Uint8Array[] = [];
        // The owner's open editor waits while the note pauses, so the copy takes
        // what it shows, and then it shows the note.
        await input.leaveLiveEditing(
          listed.binding.currentPath,
          (unsent) => {
            if (unsent.length > 0) paused = Y.mergeUpdates([roomCopy, ...unsent]);
            return input.client.ownerYDocPause(
              request(),
              {
                binding: listed.binding,
                appliedCursor: pause.savedCursor,
                rowCursor: pause.savedCursor,
                copyPath,
                roomCopy: paused,
              },
              input.signal,
            );
          },
          // Kept until the copy is written, on this pass or a later one.
          (edits) => {
            late.push(edits);
            tried.state = Y.mergeUpdates([paused, ...late]);
          },
        );
        held = await input.client.ownerYDocPausedCopy(request(), document, input.signal);
        if (!held) throw new Error("The paused note's copy is missing.");
        joined = true;
      }
      // Only a copy written for this pause names it. A held Stop may be an earlier pause's.
      let copy: { copyPath: string | null; leftOut: boolean } | null =
        input.previous.find((told) => told.pauseId === pause.pauseId) ?? null;
      if (held && !held.stop.paused.copyWritten) {
        const written = await writeHeld(held, pause.path);
        if (joined) copy = written;
      }
      if (pause.copy && !joined) {
        const file = await input.render(await relayCopy(input.relay, pause, input.signal));
        copy = {
          copyPath: await input.writes.create(
            await freeName(pause.path, input.writes),
            file.markdown,
          ),
          leftOut: file.leftOut,
        };
      }
      if (pause.copy) await input.relay.copyWritten(pause.pauseId, pause.copy.sha256, input.signal);
      input.tried.delete(pause.pauseId);
      settled.push({
        pauseId: pause.pauseId,
        objectId: pause.objectId,
        lineageClaimId: pause.lineageClaimId,
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
