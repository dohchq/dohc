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

export type ApnsClient = ReturnType<typeof createApnsClient>;

/** One HTTP/2 connection per environment to Apple's fixed hosts. `origins` exists for tests. */
export function createApnsClient(
  config: ApnsConfig,
  options: { now?: () => number; origins?: Partial<Record<ApnsEnvironment, string>> } = {},
) {
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
    async open(environment: ApnsEnvironment, signal: AbortSignal) {
      if (closed) throw Error("APNs client closed");
      const authorization = `bearer ${providerToken()}`;
      const connection = await session(environment, signal);
      signal.throwIfAborted();
      // `send` writes the stream before it returns.
      return {
        send(
          deviceToken: string,
          headers: Record<string, string>,
          body: string,
          sendSignal: AbortSignal,
        ) {
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
          // A 410's timestamp says when Apple found the token unregistered.
          return new Promise<{ status: number; timestampMs: number | null }>((resolve, reject) => {
            let status = 0;
            let text = "";
            stream.setEncoding("utf8");
            stream.once("response", (response) => {
              status = Number(response[constants.HTTP2_HEADER_STATUS]);
            });
            stream.on("data", (chunk: string) => {
              text += chunk;
              if (text.length > 8192) stream.close(constants.NGHTTP2_CANCEL);
            });
            stream.on("error", reject);
            stream.once("close", () => {
              // A reset after the headers leaves the status unconfirmed, so a 410 then ends nothing.
              if (!status || stream.rstCode !== constants.NGHTTP2_NO_ERROR)
                return reject(Error("APNs response interrupted"));
              let timestampMs: number | null = null;
              try {
                const { timestamp } = JSON.parse(text) as { timestamp?: unknown };
                if (Number.isSafeInteger(timestamp)) timestampMs = Number(timestamp);
              } catch {
                // A 200 has no body.
              }
              resolve({ status, timestampMs });
            });
          });
        },
      };
    },
    /** Forgets the provider token, after Apple refused it. */
    forgetToken() {
      token = undefined;
    },
    /** Every attempt has finished first, so the connections are destroyed, not drained. */
    async close() {
      closed = true;
      await Promise.all(
        [...sessions.values()].map(
          ({ opened }) =>
            new Promise((resolve) => {
              if (opened.destroyed) resolve(null);
              else opened.once("close", resolve).destroy();
            }),
        ),
      );
    },
  };
}
