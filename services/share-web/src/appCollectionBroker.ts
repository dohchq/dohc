/** Runs only in the trusted bootstrap. The app receives this one frame-bound port. */
export function attachAppCollectionBroker(frame: HTMLIFrameElement, send: (body: unknown, signal: AbortSignal) => Promise<Response>, lifetime: AbortSignal): void {
  let closed = false, loaded = false, pending = 0, tokens = 12, updated = Date.now();
  const channel = new MessageChannel(), controller = new AbortController(), ids = new Set<string>();
  const close = () => {closed = true;controller.abort();channel.port1.close();channel.port2.close();ids.clear();};
  lifetime.addEventListener("abort", close, {once: true});
  if (lifetime.aborted) close();
  frame.addEventListener("load", () => {
    if (closed) return;
    if (loaded) {close();return;}
    loaded = true;
    frame.contentWindow?.postMessage({kind: "dohc-app-channel", version: 1}, "*", [channel.port2]);
  });
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  channel.port1.onmessage = async event => {
    if (closed || !loaded) return;
    const body: unknown = event.data;
    if (!record(body) || typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id)) return;
    const id = body.id, reject = (status: number) => {if (!closed) channel.port1.postMessage({id, ok: false, status});};
    if (ids.has(id)) {reject(429);return;}
    let encoded: string;
    try {encoded = JSON.stringify(body);} catch {reject(400);return;}
    if (new TextEncoder().encode(encoded).byteLength > 16_384) {reject(413);return;}
    const keys = Object.keys(body).sort().join();
    if (body.op === "collection.list" ? !["id,limit,op", "afterPath,id,limit,op"].includes(keys) : body.op === "collection.create" ? keys !== "fields,id,idempotencyKey,op" : true) {reject(400);return;}
    const now = Date.now();tokens = Math.min(12, tokens + (now - updated) / 5000);updated = now;
    if (pending >= 4 || tokens < 1) {reject(429);return;}
    tokens--;pending++;ids.add(id);
    try {
      const response = await send(body, controller.signal);
      if (closed || controller.signal.aborted) {await response.body?.cancel().catch(() => {});return;}
      if (!response.ok) {await response.body?.cancel().catch(() => {});reject([400, 404, 409, 413, 429].includes(response.status) ? response.status : 503);return;}
      const reader = response.body?.getReader();if (!reader) {reject(503);return;}
      const chunks: Uint8Array[] = [];let size = 0;
      try {while (true) {const item = await reader.read();if (closed) return;if (item.done) break;size += item.value.byteLength;if (size > 1024 * 1024) throw Error();chunks.push(item.value);}}
      finally {await reader.cancel().catch(() => {});}
      const bytes = new Uint8Array(size);let offset = 0;for (const chunk of chunks) {bytes.set(chunk, offset);offset += chunk.byteLength;}
      const value: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
      if (!closed) channel.port1.postMessage({id, ok: true, value});
    } catch {reject(503);} finally {pending--;ids.delete(id);}
  };
  channel.port1.start();
}
