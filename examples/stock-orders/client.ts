type Reply = { id: string; ok: boolean; value?: any; error?: { message: string }; status?: number };
export function connect() {
  let port: MessagePort | undefined;
  const pending = new Map<
    string,
    {
      message: object;
      transfer?: Transferable[];
      resolve(value: any): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const receive = (event: MessageEvent) => {
    if (
      port ||
      event.source !== parent ||
      event.source === window ||
      event.data?.kind !== "dohc-app-channel" ||
      event.data.version !== 1 ||
      event.ports.length !== 1
    )
      return;
    window.removeEventListener("message", receive);
    port = event.ports[0];
    port.onmessage = ({ data }: MessageEvent<Reply>) => {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.ok) request.resolve(data.value);
      else
        request.reject(
          new Error(data.error?.message ?? "dohc could not complete this request. Try again."),
        );
    };
    port.start();
    for (const request of pending.values()) {
      if (request.transfer?.length) port.postMessage(request.message, request.transfer);
      else port.postMessage(request.message);
    }
  };
  window.addEventListener("message", receive);
  window.addEventListener(
    "pagehide",
    () => {
      window.removeEventListener("message", receive);
      port?.close();
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("The app closed."));
      }
      pending.clear();
    },
    { once: true },
  );
  const request = (body: object, transfer?: Transferable[]): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID(),
        message = { id, ...body };
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The response is unconfirmed. Try the same request again."));
      }, 90000);
      pending.set(id, { message, transfer, resolve, reject, timer });
      if (port) {
        if (transfer?.length) port.postMessage(message, transfer);
        else port.postMessage(message);
      }
    });
  return {
    invoke: async (operation: string, input: object = {}, key: string = crypto.randomUUID()) =>
      (await request({ op: "backend.invoke", operation, input, idempotencyKey: key })).result,
    attempt: (value: object) =>
      request({ op: "backend.attempt", operation: "placeOrder", request: value }),
    upload: async (file: File, key: string) => {
      const bytes = await file.arrayBuffer();
      return (
        await request(
          {
            op: "backend.upload",
            name: file.name,
            contentType: file.type,
            bytes,
            idempotencyKey: key,
          },
          [bytes],
        )
      ).file;
    },
  };
}
