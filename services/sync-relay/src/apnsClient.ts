import { sign } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";
import type { ApnsEnvironment } from "@dohc/workspace-contracts/push-subscriptions";
import type { ApnsConfig } from "./pushConfig";

const APPLE_ORIGINS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
// Apple refuses a provider token older than an hour and one replaced sooner than every 20 minutes.
const TOKEN_REUSE_MS = 40 * 60_000;

export interface ApnsResponse {
  status: number;
  reason: string | null;
  // When Apple found the token unregistered, on a 410.
  timestampMs: number | null;
}

/** A connection and provider token, ready: `send` writes the stream before it returns. */
export interface ApnsStream {
  send(
    deviceToken: string,
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal,
  ): Promise<ApnsResponse>;
}

export interface ApnsClient {
  readonly config: ApnsConfig;
  open(environment: ApnsEnvironment, signal: AbortSignal): Promise<ApnsStream>;
  /** Forgets the provider token, after Apple refused it. */
  forgetToken(): void;
  close(): Promise<void>;
}

/** One HTTP/2 connection per environment to Apple's fixed hosts. `origins` exists for tests. */
export function createApnsClient(
  config: ApnsConfig,
  options: { now?: () => number; origins?: Partial<Record<ApnsEnvironment, string>> } = {},
): ApnsClient {
  const now = options.now ?? Date.now;
  const sessions = new Map<
    ApnsEnvironment,
    { opened: ClientHttp2Session; ready: Promise<ClientHttp2Session> }
  >();
  let token: { value: string; issuedAtMs: number } | undefined;
  let closed = false;

  const providerToken = (): string => {
    const nowMs = now();
    if (token && nowMs - token.issuedAtMs < TOKEN_REUSE_MS) return token.value;
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${part({ alg: "ES256", kid: config.keyId })}.${part({
      iss: config.teamId,
      iat: Math.floor(nowMs / 1000),
    })}`;
    const signature = sign("sha256", Buffer.from(unsigned), {
      key: config.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    token = { value: `${unsigned}.${signature}`, issuedAtMs: nowMs };
    return token.value;
  };

  const session = (environment: ApnsEnvironment, signal: AbortSignal) => {
    let entry = sessions.get(environment);
    if (!entry) {
      const opened = connect(options.origins?.[environment] ?? APPLE_ORIGINS[environment]);
      const ready = new Promise<ClientHttp2Session>((resolve, reject) => {
        const forget = () => {
          if (sessions.get(environment)?.opened === opened) sessions.delete(environment);
        };
        opened.once("connect", () => {
          opened.unref();
          resolve(opened);
        });
        // Errors can name the host, never a device token: tokens travel only in stream paths.
        opened.on("error", (error) => {
          forget();
          reject(error);
        });
        opened.once("close", () => {
          forget();
          reject(Error("APNs connection closed"));
        });
        opened.once("goaway", forget);
      });
      ready.catch(() => {});
      entry = { opened, ready };
      sessions.set(environment, entry);
    }
    const { opened, ready } = entry;
    return new Promise<ClientHttp2Session>((resolve, reject) => {
      const abort = () => {
        // A connection that never finished opening is not kept for the next attempt.
        if (opened.connecting) opened.destroy();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };

  return {
    config,
    async open(environment, signal) {
      if (closed) throw Error("APNs client closed");
      const authorization = `bearer ${providerToken()}`;
      const connection = await session(environment, signal);
      signal.throwIfAborted();
      return {
        send(deviceToken, headers, body, sendSignal) {
          const bytes = Buffer.from(body);
          const stream = connection.request(
            {
              ...headers,
              [constants.HTTP2_HEADER_METHOD]: "POST",
              [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
              authorization,
              "content-type": "application/json",
              "content-length": String(bytes.length),
            },
            { signal: sendSignal },
          );
          stream.end(bytes);
          return new Promise<ApnsResponse>((resolve, reject) => {
            let status = 0;
            const chunks: Buffer[] = [];
            let received = 0;
            stream.once("response", (response) => {
              status = Number(response[constants.HTTP2_HEADER_STATUS]);
            });
            stream.on("data", (chunk: Buffer) => {
              received += chunk.length;
              if (received > 8192) stream.close(constants.NGHTTP2_CANCEL);
              else chunks.push(chunk);
            });
            stream.on("error", reject);
            stream.once("close", () => {
              // A reset after the headers leaves the status unconfirmed, so a 410 then ends nothing.
              if (!status || received > 8192 || stream.rstCode !== constants.NGHTTP2_NO_ERROR)
                return reject(Error("APNs response interrupted"));
              let reason: string | null = null;
              let timestampMs: number | null = null;
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString()) as Record<
                  string,
                  unknown
                >;
                if (typeof parsed.reason === "string") reason = parsed.reason.slice(0, 64);
                if (Number.isSafeInteger(parsed.timestamp)) timestampMs = Number(parsed.timestamp);
              } catch {
                // A 200 has no body.
              }
              resolve({ status, reason, timestampMs });
            });
          });
        },
      };
    },
    forgetToken() {
      token = undefined;
    },
    async close() {
      closed = true;
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(
        open.map(
          ({ opened }) =>
            new Promise<void>((resolve) => {
              if (opened.closed || opened.destroyed) return resolve();
              if (opened.connecting) {
                opened.destroy();
                return resolve();
              }
              opened.close(() => resolve());
            }),
        ),
      );
    },
  };
}
