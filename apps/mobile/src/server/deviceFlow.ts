import { exchange, ServerError, statusProblem, type Fetch } from "./client";

// The phone's side of the server's device sign-in (Better Auth's device authorization). The phone asks for a code,
// the person approves it on the server's own page, and the phone polls for its session token at the interval the
// server sets.

export const DEVICE_CLIENT_ID = "dohc-phone";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628: each slow_down adds 5 seconds to the interval. */
const SLOW_DOWN_MS = 5000;
const DEFAULT_INTERVAL_S = 5;

export interface DeviceSignIn {
  readonly deviceCode: string;
  readonly userCode: string;
  /** The server's approval page with the code filled in. */
  readonly approvalUrl: string;
  readonly intervalMs: number;
  readonly expiresAtMs: number;
}

export type DeviceOutcome = { readonly kind: "token"; readonly token: string } | { readonly kind: "denied" } | { readonly kind: "expired" };

interface Runtime {
  readonly fetch: Fetch;
  readonly signal: AbortSignal;
  readonly now: () => number;
  /** Waits, and rejects as cancelled once `signal` aborts. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

const isFields = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export async function startDeviceSignIn(origin: string, runtime: Pick<Runtime, "fetch" | "signal" | "now">): Promise<DeviceSignIn> {
  const { status, body } = await exchange(runtime.fetch, `${origin}/api/auth/device/code`, {
    method: "POST", body: { client_id: DEVICE_CLIENT_ID }, signal: runtime.signal,
  });
  if (status !== 200) throw new ServerError(statusProblem(status), status);
  if (!isFields(body) || typeof body.device_code !== "string" || !body.device_code || body.device_code.length > 2048 ||
      typeof body.user_code !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.user_code) || !positive(body.expires_in) ||
      (body.interval !== undefined && !positive(body.interval))) {
    throw new ServerError("invalid", status);
  }
  // The page is built on the address the person typed, never taken from the answer, so the phone opens only that
  // server's own page. It accepts the code as ?user_code= (services/workspace-api/src/routes.ts, the /device page).
  const approval = new URL("/device", origin);
  approval.searchParams.set("user_code", body.user_code);
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    approvalUrl: approval.href,
    intervalMs: (body.interval ?? DEFAULT_INTERVAL_S) * 1000,
    expiresAtMs: runtime.now() + body.expires_in * 1000,
  };
}

/** Polls until the person approves or denies the code, or it expires. */
export async function waitForDeviceToken(origin: string, start: DeviceSignIn, runtime: Runtime): Promise<DeviceOutcome> {
  let intervalMs = start.intervalMs;
  for (;;) {
    await runtime.sleep(intervalMs, runtime.signal);
    if (runtime.now() >= start.expiresAtMs) return { kind: "expired" };
    const { status, body } = await exchange(runtime.fetch, `${origin}/api/auth/device/token`, {
      method: "POST", body: { grant_type: GRANT_TYPE, device_code: start.deviceCode, client_id: DEVICE_CLIENT_ID }, signal: runtime.signal,
    });
    if (status === 200) {
      if (!isFields(body) || typeof body.access_token !== "string" || !body.access_token || body.access_token.length > 4096) {
        throw new ServerError("invalid", status);
      }
      return { kind: "token", token: body.access_token };
    }
    switch (isFields(body) ? body.error : undefined) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += SLOW_DOWN_MS;
        continue;
      case "access_denied":
        return { kind: "denied" };
      // invalid_grant: the server no longer has the code.
      case "expired_token":
      case "invalid_grant":
        return { kind: "expired" };
    }
    throw new ServerError(statusProblem(status), status);
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ServerError("cancelled"));
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      reject(new ServerError("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
