export type Fields = { destination: string; name?: string };
export type Page = { records: Array<{ path: string; recordId: string | null; fields: Partial<Fields> }>; nextPath: string | null };
export type Receipt = { kind: "accepted"; acceptanceId: string; objectId: string; path: string; momentId: string; acceptedAtMs: number };
export interface CollectionClient {
  list(input: { limit: number; afterPath?: string }): Promise<Page>;
  create(input: { idempotencyKey: string; fields: Fields }): Promise<Receipt>;
}
export class CollectionError extends Error {
  constructor(readonly status: number) { super("Collection request refused."); }
}

export function connectCollection(): CollectionClient & { close(): void } {
  let port: MessagePort | undefined, closed = false;
  const pending = new Map<string, { message: object; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const failAll = () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new CollectionError(503)); }
    pending.clear();
  };
  const receiveChannel = (event: MessageEvent) => {
    if (closed || event.source !== window.parent || event.source === window || event.data?.kind !== "dohc-app-channel" || event.data?.version !== 1 || event.ports.length !== 1) return;
    if (port) { port.close(); failAll(); } port = event.ports[0];
    port.onmessage = ({ data }: MessageEvent) => {
      if (!data || typeof data.id !== "string") return;
      const item = pending.get(data.id); if (!item) return;
      pending.delete(data.id); clearTimeout(item.timer);
      if (data.ok === true) item.resolve(data.value);
      else item.reject(new CollectionError([400, 404, 409, 413, 429, 503].includes(data.status) ? data.status : 503));
    };
    port.start();
    for (const item of pending.values()) port.postMessage(item.message);
  };
  window.addEventListener("message", receiveChannel);
  function request(op: string, input: object): Promise<unknown> {
    if (closed) return Promise.reject(new CollectionError(503));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new CollectionError(503)); }, 15_000);
      const message = { id, op, ...input };
      pending.set(id, { message, resolve, reject, timer });
      try { port?.postMessage(message); }
      catch { pending.delete(id); clearTimeout(timer); reject(new CollectionError(503)); }
    });
  }
  return {
    list: input => request("collection.list", input) as Promise<Page>,
    create: input => request("collection.create", input) as Promise<Receipt>,
    close() { closed = true; port?.close(); failAll(); window.removeEventListener("message", receiveChannel); },
  };
}
