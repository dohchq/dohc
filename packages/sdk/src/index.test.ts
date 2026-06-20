import { describe, expect, it } from "vitest";
import {
  DohcSdkError,
  createDohcClient,
  createPostMessageTransport,
  DOHC_SDK_PROTOCOL,
} from ".";

describe("@dohc/sdk", () => {
  it("reads files through the configured transport", async () => {
    const client = createDohcClient({
      transport: {
        async request(method, params) {
          expect(method).toBe("files.read");
          expect(params).toEqual({ path: "notes/today.md" });
          return { text: "today" };
        },
      },
    });

    await expect(client.files.read("notes/today.md")).resolves.toBe("today");
  });

  it("surfaces host errors with stable codes", async () => {
    const client = createDohcClient({
      transport: {
        async request() {
          throw new DohcSdkError("NOPE", "Denied");
        },
      },
    });

    await expect(client.files.read("secret.md")).rejects.toMatchObject({
      code: "NOPE",
      message: "Denied",
    });
  });

  it("posts requests and resolves matching host responses", async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const currentWindow = {
      parent: undefined,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      addEventListener(_type: "message", listener: EventListener) {
        listeners.add(listener as (event: MessageEvent) => void);
      },
      removeEventListener(_type: "message", listener: EventListener) {
        listeners.delete(listener as (event: MessageEvent) => void);
      },
    } as unknown as Window;
    const targetWindow = {
      postMessage(message: unknown) {
        const request = message as { id: string };
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              data: {
                protocol: DOHC_SDK_PROTOCOL,
                id: request.id,
                ok: true,
                result: { files: { read: true, write: false } },
              },
            } as MessageEvent);
          }
        });
      },
    } as unknown as Window;

    const transport = createPostMessageTransport({
      currentWindow,
      targetWindow,
      timeoutMs: 1000,
    });

    await expect(transport.request("capabilities")).resolves.toEqual({
      files: { read: true, write: false },
    });
  });
});
