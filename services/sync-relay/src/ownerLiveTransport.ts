import {WebSocket} from "ws";

export interface OwnerLiveTransport {
  send(bytes: Uint8Array): Promise<void>;
  close(): void;
}

/** Node-only owner transport. Credentials never enter the URL or subprotocol. */
export function connectOwnerLiveTransport(input: {
  url: URL;
  bearer: string;
  maxFrameBytes: number;
  signal: AbortSignal;
  receive(bytes: Uint8Array): void;
  closed(): void;
}): Promise<OwnerLiveTransport> {
  input.signal.throwIfAborted();
  if (!/^[^\s]+$/.test(input.bearer)) throw new TypeError("Invalid owner bearer.");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(input.url, "dohc-live-v1", {
      headers: {authorization: `Bearer ${input.bearer}`},
      maxPayload: input.maxFrameBytes,
      perMessageDeflate: false,
      followRedirects: false,
    });
    let finished = false;
    const stop = () => {
      if (finished) return;
      finished = true;
      input.signal.removeEventListener("abort", stop);
      socket.terminate();
      reject(new Error("Owner live transport closed."));
      input.closed();
    };
    input.signal.addEventListener("abort", stop, {once: true});
    socket.on("error", stop);
    socket.on("close", stop);
    socket.on("unexpected-response", (_request, response) => {response.destroy(); stop();});
    socket.on("message", (data, binary) => {
      if (finished) return;
      if (!binary || !(data instanceof Buffer) || data.length > input.maxFrameBytes) {stop(); return;}
      input.receive(data);
    });
    socket.once("open", () => {
      if (finished || input.signal.aborted || socket.protocol !== "dohc-live-v1") {stop(); return;}
      resolve({close: stop, send: bytes => new Promise<void>((done, fail) => {
        if (finished || input.signal.aborted) {fail(new Error("Owner live transport closed.")); return;}
        socket.send(bytes, {binary: true}, error => {if (error) fail(error); else done();});
      })});
    });
    if (input.signal.aborted) stop();
  });
}
