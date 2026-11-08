import type {LiveHostRegistration} from "./liveHostRegistration.js";

export type OwnerWakeKind = "change" | "settle";

/** Each captured registration retains changes and settlement requests separately. */
export class OwnerOutboxWake {
  readonly #pending = new Map<string, {registration: LiveHostRegistration; dirty: Set<OwnerWakeKind>; running: boolean; dispose(): void}>();
  #scheduled = false;
  #closed = false;
  constructor(private readonly options: {
    canRun(registration: LiveHostRegistration): boolean;
    run(registration: LiveHostRegistration, kind: OwnerWakeKind): Promise<boolean>;
    onError(error: unknown): void;
  }) {}

  wake(registration: LiveHostRegistration, kind: OwnerWakeKind = "change"): void {
    if (this.#closed || registration.invalidated.aborted) return;
    const key = JSON.stringify([registration.binding.workspaceId, registration.id]);
    let entry = this.#pending.get(key);
    if (entry && entry.registration.invalidated !== registration.invalidated) {
      entry.dispose(); this.#pending.delete(key); entry = undefined;
    }
    if (!entry) {
      const abort = () => {
        if (this.#pending.get(key)?.registration.invalidated === registration.invalidated) {
          this.#pending.get(key)!.dispose(); this.#pending.delete(key);
        }
      };
      registration.invalidated.addEventListener("abort", abort, {once: true});
      entry = {registration, dirty: new Set([kind]), running: false,
        dispose: () => registration.invalidated.removeEventListener("abort", abort)};
      this.#pending.set(key, entry);
    } else entry.dirty.add(kind);
    this.pump();
  }

  pump(): void {
    if (this.#closed || this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      for (const [key, entry] of this.#pending) {
        if (entry.running || entry.dirty.size === 0 || !this.options.canRun(entry.registration)) continue;
        const kind = entry.dirty.has("change") ? "change" : "settle";
        entry.running = true; entry.dirty.delete(kind);
        void this.options.run(entry.registration, kind).then(more => {if (more) entry.dirty.add(kind);}, error => {
          this.options.onError(error);
        }).finally(() => {
          entry.running = false;
          if (this.#pending.get(key) === entry && entry.dirty.size === 0) {entry.dispose(); this.#pending.delete(key);}
          else if (this.#pending.get(key) === entry) {this.#pending.delete(key); this.#pending.set(key, entry);}
          this.pump();
        });
      }
    });
  }

  close(): void {
    this.#closed = true;
    for (const entry of this.#pending.values()) entry.dispose();
    this.#pending.clear();
  }
}
