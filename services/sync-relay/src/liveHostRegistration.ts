import { isDeepStrictEqual } from "node:util";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";

export interface LiveHostRegistration {
  readonly id: number;
  readonly binding: LiveObjectBinding;
  readonly invalidated: AbortSignal;
}

/** Grant selectors remain in each admitted receipt; a shared host owns the document. */
export function sameLiveHostDocument(left: LiveObjectBinding, right: LiveObjectBinding): boolean {
  const {selectorPaths: _leftSelectors, ...leftDocument} = left;
  const {selectorPaths: _rightSelectors, ...rightDocument} = right;
  return isDeepStrictEqual(leftDocument, rightDocument);
}

/** One registration per object. Reuse keeps browser readers on the host's current native handle. */
export class LiveHostRegistrations {
  readonly #registrations = new Map<string, { value: LiveHostRegistration; lifetime: AbortController }>();
  constructor(private readonly connection: {
    client: EngineClient; workspace: string; nextRequestId(): number; deadlineMs: number;
  }) {}

  capture(binding: LiveObjectBinding): LiveHostRegistration {
    const saved = this.#registrations.get(binding.objectId);
    if (!saved || !sameLiveHostDocument(saved.value.binding, binding)) throw new Error("Live host registration is unavailable.");
    return { ...saved.value, binding: structuredClone(saved.value.binding) };
  }

  invalidate(objectId: string): void {
    const saved = this.#registrations.get(objectId);
    this.#registrations.delete(objectId);
    saved?.lifetime.abort(new Error("Live host registration was replaced."));
  }

  remember(binding: LiveObjectBinding, id: number): LiveHostRegistration {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid live host registration.");
    this.invalidate(binding.objectId);
    const lifetime = new AbortController();
    const value = { id, binding: parseLiveObjectBinding(binding), invalidated: lifetime.signal };
    this.#registrations.set(binding.objectId, { value, lifetime });
    return this.capture(binding);
  }

  async ensure(value: LiveObjectBinding, signal?: AbortSignal): Promise<LiveHostRegistration> {
    const binding = parseLiveObjectBinding(value);
    signal?.throwIfAborted();
    const saved = this.#registrations.get(binding.objectId);
    if (saved && sameLiveHostDocument(saved.value.binding, binding)) return this.capture(binding);
    this.invalidate(binding.objectId);
    const response = await this.connection.client.sendRequest({
      id: this.connection.nextRequestId(), method: "liveApplication.register", workspace: this.connection.workspace,
      params: { binding: {...binding, selectorPaths: [...binding.selectorPaths]} }, deadlineMs: this.connection.deadlineMs,
    }, signal);
    signal?.throwIfAborted();
    const id = (response.result as { registrationId?: unknown })?.registrationId;
    if (typeof id !== "number") throw new Error("Invalid live host registration.");
    return this.remember(binding, id);
  }
}
