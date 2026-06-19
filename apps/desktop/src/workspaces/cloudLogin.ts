import type { CloudCredentials } from "./cloudCredentialStore";

// Desktop side of the OAuth device-authorization flow against dohc Cloud (or
// a self-host server): start() asks the server for a short user code, the
// user approves it in the system browser, poll() exchanges the device code
// for a session token once approved. The token is persisted via the injected
// store (safeStorage-encrypted in production) and NEVER returned to callers —
// the renderer only ever sees status + email.

const CLIENT_ID = "dohc-desktop";

export interface CloudLoginStore {
  load(): Promise<CloudCredentials | null>;
  save(credentials: CloudCredentials): Promise<void>;
  clear(): Promise<void>;
}

export interface CloudLoginOptions {
  store: CloudLoginStore;
  defaultServerUrl: string;
  fetch?: typeof fetch;
}

export interface CloudLogin {
  start(serverUrl?: string): Promise<{ userCode: string; verificationUri: string }>;
  poll(): Promise<{ status: "pending" | "complete" | "denied" | "expired"; email?: string }>;
  status(): Promise<{ connected: boolean; email?: string; serverUrl?: string }>;
  logout(): Promise<void>;
  // The persisted token for the sync engine (main-process only — never IPC).
  credentials(): Promise<CloudCredentials | null>;
}

export function createCloudLogin(options: CloudLoginOptions): CloudLogin {
  const fetchImpl = options.fetch ?? fetch;
  let pending: { serverUrl: string; deviceCode: string } | null = null;

  async function postJson(url: string, body: unknown): Promise<Response> {
    return fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  return {
    async start(serverUrl) {
      const server = (serverUrl ?? options.defaultServerUrl).replace(/\/+$/, "");
      const response = await postJson(`${server}/api/auth/device/code`, {
        client_id: CLIENT_ID,
      });
      if (!response.ok) {
        throw new Error(`Cloud login unavailable (${response.status}) at ${server}`);
      }
      const data = (await response.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete?: string;
      };
      pending = { serverUrl: server, deviceCode: data.device_code };
      return {
        userCode: data.user_code,
        verificationUri: data.verification_uri_complete ?? data.verification_uri,
      };
    },

    async poll() {
      if (!pending) throw new Error("No cloud login in progress");
      const { serverUrl, deviceCode } = pending;
      const response = await postJson(`${serverUrl}/api/auth/device/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CLIENT_ID,
      });
      const data = (await response.json()) as {
        access_token?: string;
        error?: string;
      };
      if (data.access_token) {
        // Resolve who we are so the UI can show it; the token itself stays in
        // the encrypted store.
        const session = await fetchImpl(`${serverUrl}/api/auth/get-session`, {
          headers: { authorization: `Bearer ${data.access_token}` },
        });
        const body = (await session.json()) as { user?: { email?: string } } | null;
        const email = body?.user?.email ?? "";
        await options.store.save({ serverUrl, email, token: data.access_token });
        pending = null;
        return { status: "complete" as const, email };
      }
      switch (data.error) {
        case "authorization_pending":
        case "slow_down":
          return { status: "pending" as const };
        case "access_denied":
          pending = null;
          return { status: "denied" as const };
        default:
          // expired_token and anything unrecognized: the code is dead.
          pending = null;
          return { status: "expired" as const };
      }
    },

    async status() {
      const credentials = await options.store.load();
      return credentials
        ? { connected: true, email: credentials.email, serverUrl: credentials.serverUrl }
        : { connected: false };
    },

    async logout() {
      pending = null;
      await options.store.clear();
    },

    credentials() {
      return options.store.load();
    },
  };
}
