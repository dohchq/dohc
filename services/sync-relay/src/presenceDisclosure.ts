import { createHmac, randomBytes } from "node:crypto";
import { badRequest } from "./errors";
import { accountDisplayName } from "./discussionRoutes";
import type { PresenceEntry, PresenceSnapshot } from "./presence";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function hasIdentity(value: unknown): boolean {
  const fields = record(value);
  if (!fields) return Array.isArray(value) && value.some(hasIdentity);
  return Object.entries(fields).some(
    ([key, item]) =>
      /^(user|userId|clientId|name|displayName|email|access|color|actor|actorKey|identity|ownerDisplayName)$/i.test(
        key,
      ) ||
      (key !== "selectedElementIds" && hasIdentity(item)),
  );
}
function position(value: unknown): boolean {
  if (value === null) return true;
  const r = record(value);
  if (!r || Object.keys(r).some((k) => !["type", "item", "tname", "assoc"].includes(k)))
    return false;
  return Object.entries(r).every(([k, v]) => {
    if (k === "tname") return v === null || (typeof v === "string" && v.length <= 256);
    if (k === "assoc") return typeof v === "number" && Number.isSafeInteger(v);
    if (v === null) return true;
    const id = record(v);
    return (
      id !== null &&
      Object.keys(id).every((k) => k === "client" || k === "clock") &&
      [id.client, id.clock].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    );
  });
}
function validAwareness(value: unknown): boolean {
  if (value === null) return true;
  const r = record(value);
  if (!r) return false;
  return Object.entries(r).every(([k, v]) => {
    if (k === "cursor") {
      if (v === null) return true;
      const cursor = record(v);
      return (
        cursor !== null &&
        Object.keys(cursor).every((k) => k === "anchor" || k === "head") &&
        position(cursor.anchor) &&
        position(cursor.head)
      );
    }
    if (k === "pointer") {
      const p = record(v);
      return (
        p !== null &&
        Object.keys(p).every((k) => ["x", "y", "tool"].includes(k)) &&
        [p.x, p.y].every(
          (n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 10_000_000,
        ) &&
        (p.tool === "pointer" || p.tool === "laser")
      );
    }
    if (k === "button") return v === "up" || v === "down";
    if (k === "selectedElementIds") {
      const ids = record(v);
      return (
        ids !== null &&
        Object.entries(ids).every(
          ([id, selected]) =>
            id.length > 0 &&
            id.isWellFormed() &&
            !/[\u0000-\u001f\u007f-\u009f]/.test(id) &&
            !["__proto__", "constructor", "prototype"].includes(id) &&
            selected === true,
        )
      );
    }
    return false;
  });
}

// Validate the actual JSON inside the Yjs frame. It is never rewritten by the relay.
function validateUpdate(update: string, yc: number): void {
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(update))
      throw new Error();
    const bytes = Buffer.from(update, "base64");
    let offset = 0;
    const uint = () => {
      let value = 0;
      let scale = 1;
      for (let i = 0; i < 8; i++) {
        if (offset >= bytes.length) throw new Error();
        const byte = bytes[offset++]!;
        value += (byte & 127) * scale;
        if (!Number.isSafeInteger(value)) throw new Error();
        if (byte < 128) return value;
        scale *= 128;
      }
      throw new Error();
    };
    if (uint() !== 1 || uint() !== yc) throw new Error();
    uint();
    const length = uint();
    if (offset + length !== bytes.length) throw new Error();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset));
    const state: unknown = JSON.parse(decoded);
    if (hasIdentity(state) || !validAwareness(state)) throw new Error();
  } catch {
    throw badRequest("invalid presence awareness");
  }
}

export function sanitizePresenceState(
  value: unknown,
  canEdit: boolean,
  reservedAgent: boolean,
): unknown {
  if (value === null || value === undefined) return null;
  const r = record(value);
  if (!r) throw badRequest("presence state must be an object");
  const state: Record<string, unknown> = {};
  if (typeof r.typing === "boolean") state.typing = r.typing;
  if (r.state === "viewing" || r.state === "typing") state.state = r.state;
  // The reserved-client spoof is owned by fix/agent-presence-owner.
  if (reservedAgent && r.agent === true && (r.activity === "working" || r.activity === "idle")) {
    state.agent = true;
    state.activity = r.activity;
  }
  if (r.update !== undefined || r.yc !== undefined) {
    if (
      hasIdentity(r) ||
      Object.keys(r).some((key) => !["yc", "update", "typing", "state"].includes(key))
    )
      throw badRequest("invalid presence awareness");
    if (
      typeof r.yc !== "number" ||
      !Number.isSafeInteger(r.yc) ||
      r.yc < 0 ||
      typeof r.update !== "string"
    )
      throw badRequest("invalid presence awareness");
    validateUpdate(r.update, r.yc);
    if (canEdit) {
      state.yc = r.yc;
      state.update = r.update;
    }
  }
  return state;
}

function paletteSlot(value: string): number {
  let hash = 2166136261;
  for (const point of value) hash = Math.imul(hash ^ point.codePointAt(0)!, 16777619) >>> 0;
  return hash % 7;
}

export function createPresenceProjection(
  lookupLabel: ((userId: string) => string | null | Promise<string | null>) | undefined,
) {
  const secret = randomBytes(32);
  const token = (...parts: string[]) =>
    createHmac("sha256", secret).update(JSON.stringify(parts)).digest("base64url");
  return async (
    snapshot: PresenceSnapshot,
    input: {
      scopeKey: string;
      viewerUserId: string;
      viewerClientId: string | null;
      disclose(peer: PresenceEntry): boolean;
      canEdit(peer: PresenceEntry): boolean | null;
    },
  ) => {
    const labels = new Map<string, string | null>();
    const lookups = new Map<string, Promise<void>>();
    for (const peer of snapshot.peers) {
      if (input.canEdit(peer) === null || !input.disclose(peer) || lookups.has(peer.userId))
        continue;
      lookups.set(
        peer.userId,
        accountDisplayName(lookupLabel, peer.userId).then((label) => {
          labels.set(
            peer.userId,
            label !== null && /[^\s@]+@[^\s@]+\.[^\s@]+/.test(label) ? null : label,
          );
        }),
      );
    }
    await Promise.all(lookups.values());
    // Everything below is synchronous. A revoke/downgrade during a label lookup takes effect here.
    const admitted = snapshot.peers.flatMap((peer) => {
      const canEdit = input.canEdit(peer);
      return canEdit === null ? [] : [{ peer, canEdit }];
    });
    const faces = new Map<string, string>();
    for (const { peer } of admitted)
      if (!faces.has(peer.userId)) faces.set(peer.userId, peer.sessionId);
    const peers = admitted.map(({ peer, canEdit }) => {
      const displayName = input.disclose(peer) ? (labels.get(peer.userId) ?? null) : null;
      const sessionToken = token("session", input.viewerUserId, input.scopeKey, peer.sessionId);
      const faceToken = token("face", input.viewerUserId, input.scopeKey, faces.get(peer.userId)!);
      return {
        faceToken,
        sessionToken,
        isSelf: peer.userId === input.viewerUserId && peer.clientId === input.viewerClientId,
        displayName,
        paletteSlot: paletteSlot(displayName === null ? sessionToken : peer.userId),
        state: sanitizePresenceState(peer.state, canEdit, true),
        updatedAtMs: peer.updatedAtMs,
      };
    });
    return { version: snapshot.version, peers };
  };
}
