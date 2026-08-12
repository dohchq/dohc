import type {
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type * as Y from "yjs";
import { bindDocPresence, type DocPresenceBinding } from "./docPresence";
import type { PresenceScope, PresenceTransport } from "./presenceChannel";

const CURSOR_PUBLISH_MS = 33;
const MAX_POINTER_COORDINATE = 10_000_000;
// The awareness update is base64-wrapped inside the 8 KiB presence state.
// This shape leaves room for the wrapper and user/pointer fields even under
// the IPC boundary's conservative six-bytes-per-character estimator.
const MAX_SELECTED_ELEMENT_IDS = 16;
const MAX_ELEMENT_ID_CHARS = 24;
const UNSAFE_ELEMENT_ID = /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/;

const COLORS = [
  { background: "#dbeafe", stroke: "#2563eb" },
  { background: "#dcfce7", stroke: "#16a34a" },
  { background: "#fef3c7", stroke: "#d97706" },
  { background: "#fce7f3", stroke: "#db2777" },
  { background: "#ede9fe", stroke: "#7c3aed" },
  { background: "#cffafe", stroke: "#0891b2" },
] as const;

export type ExcalidrawPointerUpdate = {
  pointer: { x: number; y: number; tool: "pointer" | "laser" };
  button: "down" | "up";
};

export type ExcalidrawPresenceCollaboration = {
  transport: PresenceTransport;
  clientId: string;
  displayName: string;
};

export type ExcalidrawPresenceFactory = {
  transportForScope: (scope: PresenceScope) => PresenceTransport;
  clientId: string;
  displayName: string;
};

export type ExcalidrawPresenceBinding = {
  updatePointer(update: ExcalidrawPointerUpdate): void;
  updateSelection(selectedElementIds: Record<string, boolean>): void;
  destroy(): void;
};

type PresenceScheduler = {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
};

const defaultScheduler: PresenceScheduler = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function excalidrawPresenceTopic(input: {
  workspaceId: string;
  versionId: string;
  objectId: string;
}): string {
  return `scene:${JSON.stringify([
    input.workspaceId,
    input.versionId,
    input.objectId,
  ])}`;
}

function hash(value: string | number): number {
  const text = String(value);
  let result = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    result ^= text.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function colorFor(value: string | number): (typeof COLORS)[number] {
  return COLORS[hash(value) % COLORS.length]!;
}

function cleanName(value: unknown): string {
  if (typeof value !== "string") return "Someone";
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/g, "")
    .trim()
    .slice(0, 64);
  return cleaned || "Someone";
}

function finiteCoordinate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(
    -MAX_POINTER_COORDINATE,
    Math.min(MAX_POINTER_COORDINATE, value),
  );
}

function cleanPointer(value: unknown): Collaborator["pointer"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pointer = value as Record<string, unknown>;
  const x = finiteCoordinate(pointer.x);
  const y = finiteCoordinate(pointer.y);
  if (x === null || y === null) return undefined;
  if (pointer.tool !== "pointer" && pointer.tool !== "laser") return undefined;
  return { x, y, tool: pointer.tool };
}

function cleanSelection(value: unknown): Record<string, true> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const selected = Object.create(null) as Record<string, true>;
  const entries = Object.entries(value)
    .filter(
      ([id, isSelected]) =>
        isSelected === true &&
        id.length > 0 &&
        id.length <= MAX_ELEMENT_ID_CHARS &&
        id !== "__proto__" &&
        id !== "constructor" &&
        id !== "prototype" &&
        !UNSAFE_ELEMENT_ID.test(id),
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [id] of entries.slice(0, MAX_SELECTED_ELEMENT_IDS)) {
    selected[id] = true;
  }
  return selected;
}

function sameSelection(
  left: Record<string, boolean>,
  right: Record<string, boolean>,
): boolean {
  const leftIds = Object.keys(left).filter((id) => left[id] === true).sort();
  const rightIds = Object.keys(right).filter((id) => right[id] === true).sort();
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id, index) => id === rightIds[index])
  );
}

function collaboratorsFromAwareness(
  binding: DocPresenceBinding,
): Map<SocketId, Collaborator> {
  const collaborators = new Map<SocketId, Collaborator>();
  for (const [awarenessClientId, rawState] of binding.awareness.getStates()) {
    if (awarenessClientId === binding.awareness.clientID) continue;
    if (!rawState || typeof rawState !== "object") continue;
    const state = rawState as Record<string, unknown>;
    const rawUser =
      state.user && typeof state.user === "object"
        ? (state.user as Record<string, unknown>)
        : {};
    const socketId = `awareness-${awarenessClientId}` as SocketId;
    const pointer = cleanPointer(state.pointer);
    const button =
      state.button === "down" || state.button === "up"
        ? state.button
        : undefined;
    const selectedElementIds = cleanSelection(state.selectedElementIds);
    const color = colorFor(awarenessClientId);
    collaborators.set(socketId, {
      socketId,
      id: socketId,
      username: cleanName(rawUser.name),
      color: { ...color },
      ...(pointer ? { pointer } : {}),
      ...(button ? { button } : {}),
      ...(selectedElementIds ? { selectedElementIds } : {}),
    });
  }
  return collaborators;
}

export function bindExcalidrawPresence(options: {
  doc: Y.Doc;
  transport: PresenceTransport;
  topic: string;
  clientId: string;
  displayName: string;
  getApi: () => ExcalidrawImperativeAPI | null;
  scheduler?: PresenceScheduler;
}): ExcalidrawPresenceBinding {
  const scheduler = options.scheduler ?? defaultScheduler;
  let destroyed = false;
  let pendingPointer: ExcalidrawPointerUpdate | null = null;
  let pointerTimer: unknown | null = null;
  let lastPointerAt = Number.NEGATIVE_INFINITY;
  let lastSelection: Record<string, boolean> = {};

  const binding = bindDocPresence({
    doc: options.doc,
    transport: options.transport,
    topic: options.topic,
    clientId: options.clientId,
    user: {
      name: cleanName(options.displayName),
      color: colorFor(options.clientId).stroke,
    },
    onPeers: () => undefined,
  });

  const renderCollaborators = (): void => {
    if (destroyed) return;
    try {
      options.getApi()?.updateScene({
        collaborators: collaboratorsFromAwareness(binding),
      });
    } catch {
      // Presence is optional. It must never affect scene editing or recovery.
    }
  };
  binding.awareness.on("change", renderCollaborators);
  renderCollaborators();

  const publishPointer = (): void => {
    pointerTimer = null;
    const update = pendingPointer;
    pendingPointer = null;
    if (destroyed || !update) return;
    const pointer = cleanPointer(update.pointer);
    if (!pointer) return;
    lastPointerAt = scheduler.now();
    try {
      binding.awareness.setLocalState({
        ...(binding.awareness.getLocalState() ?? {}),
        pointer,
        button: update.button === "down" ? "down" : "up",
      });
    } catch {
      // A dead awareness object cannot make editing fail.
    }
  };

  return {
    updatePointer(update) {
      if (destroyed || !cleanPointer(update.pointer)) return;
      pendingPointer = update;
      const elapsed = scheduler.now() - lastPointerAt;
      if (elapsed >= CURSOR_PUBLISH_MS) {
        if (pointerTimer !== null) scheduler.cancel(pointerTimer);
        publishPointer();
        return;
      }
      if (pointerTimer === null) {
        pointerTimer = scheduler.schedule(
          publishPointer,
          CURSOR_PUBLISH_MS - elapsed,
        );
      }
    },
    updateSelection(selectedElementIds) {
      if (destroyed) return;
      const selection = cleanSelection(selectedElementIds) ?? Object.create(null);
      if (sameSelection(lastSelection, selection)) return;
      lastSelection = selection;
      try {
        binding.awareness.setLocalStateField("selectedElementIds", selection);
      } catch {
        // A dead awareness object cannot make editing fail.
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (pointerTimer !== null) scheduler.cancel(pointerTimer);
      pointerTimer = null;
      pendingPointer = null;
      binding.awareness.off("change", renderCollaborators);
      try {
        options.getApi()?.updateScene({ collaborators: new Map() });
      } catch {
        // The canvas may already be gone.
      }
      binding.destroy();
    },
  };
}
