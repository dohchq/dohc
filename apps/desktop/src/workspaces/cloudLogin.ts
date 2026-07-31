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
  start(serverUrl?: string, relayUrl?: string): Promise<{ userCode: string; verificationUri: string }>;
  poll(): Promise<{ status: "pending" | "complete" | "denied" | "expired"; email?: string }>;
  status(): Promise<{ connected: boolean; email?: string; serverUrl?: string; relayUrl?: string }>;
  logout(): Promise<void>;
  // The persisted token for the sync engine (main-process only — never IPC).
  credentials(): Promise<CloudCredentials | null>;
}

export interface CompletedCloudLoginSessionOptions {
  clearCachedCredentials(): void;
  stopEngines(): Promise<void>;
  closeRelayTransportWorkspaces(): Promise<void>;
  refreshCredentialCache(): Promise<void>;
  reconcileCloud(): void;
}

export async function adoptCompletedCloudLoginSession(
  options: CompletedCloudLoginSessionOptions,
): Promise<void> {
  options.clearCachedCredentials();
  const failures: unknown[] = [];

  for (const cleanup of [
    options.stopEngines,
    options.closeRelayTransportWorkspaces,
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await options.refreshCredentialCache();
  } catch (error) {
    failures.push(error);
    throwTransitionFailures(failures);
  }

  try {
    options.reconcileCloud();
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) throwTransitionFailures(failures);
}

function throwTransitionFailures(failures: unknown[]): never {
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(
    failures,
    "Cloud login session transition did not complete.",
  );
}

type PendingLogin = {
  epoch: number;
  serverUrl: string;
  relayUrl?: string;
  deviceCode: string;
};

type CloudLoginPollResult = {
  status: "pending" | "complete" | "denied" | "expired";
  email?: string;
};

export function createCloudLogin(options: CloudLoginOptions): CloudLogin {
  const fetchImpl = options.fetch ?? fetch;
  let pending: PendingLogin | null = null;
  let attemptEpoch = 0;
  let storeMutation: Promise<void> = Promise.resolve();
  let pollInFlight: {
    attempt: PendingLogin;
    promise: Promise<CloudLoginPollResult>;
  } | null = null;

  function assertCurrentAttempt(attempt: PendingLogin): void {
    if (pending !== attempt || attempt.epoch !== attemptEpoch) {
      throw new Error("Cloud login was cancelled.");
    }
  }

  function failCloudLoginIdentity(attempt: PendingLogin): never {
    if (pending === attempt && attempt.epoch === attemptEpoch) pending = null;
    throw new Error(
      "Cloud login failed because the server could not confirm your identity. Contact the server administrator.",
    );
  }

  function mutateStore<Result>(run: () => Promise<Result>): Promise<Result> {
    const mutation = storeMutation.then(run, run);
    storeMutation = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }

  async function postJson(url: string, body: unknown): Promise<Response> {
    return fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function pollAttempt(attempt: PendingLogin): Promise<CloudLoginPollResult> {
    const { serverUrl, relayUrl, deviceCode } = attempt;
    const response = await postJson(`${serverUrl}/api/auth/device/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: CLIENT_ID,
    });
    assertCurrentAttempt(attempt);
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
      assertCurrentAttempt(attempt);
      if (!session.ok) failCloudLoginIdentity(attempt);
      const body = (await session.json()) as {
        user?: { email?: unknown; id?: unknown };
      } | null;
      assertCurrentAttempt(attempt);
      // The Better Auth user id (opaque uuid) becomes the reactor author key —
      // never the email — so no PII replicates into the CRDT.
      const userId = body?.user?.id;
      if (typeof userId !== "string" || userId.length === 0) {
        failCloudLoginIdentity(attempt);
      }
      const email = typeof body?.user?.email === "string" ? body.user.email : "";
      const credentials = {
        serverUrl,
        ...(relayUrl ? { relayUrl } : {}),
        email,
        userId,
        token: data.access_token,
      };
      assertCurrentAttempt(attempt);
      await mutateStore(async () => {
        assertCurrentAttempt(attempt);
        await options.store.save(credentials);
        // logout invalidates attempts immediately while its clear waits behind
        // this save. A superseding start cannot interleave because it uses the
        // same mutation queue.
        assertCurrentAttempt(attempt);
        pending = null;
      });
      return { status: "complete", email };
    }
    assertCurrentAttempt(attempt);
    switch (data.error) {
      case "authorization_pending":
      case "slow_down":
        return { status: "pending" };
      case "access_denied":
        pending = null;
        return { status: "denied" };
      default:
        // expired_token and anything unrecognized: the code is dead.
        pending = null;
        return { status: "expired" };
    }
  }

  return {
    async start(serverUrl, relayUrl) {
      const epoch = await mutateStore(async () => {
        attemptEpoch += 1;
        pending = null;
        return attemptEpoch;
      });
      const server = (serverUrl ?? options.defaultServerUrl).replace(/\/+$/, "");
      const relay = relayUrl?.trim().replace(/\/+$/, "");
      const response = await postJson(`${server}/api/auth/device/code`, {
        client_id: CLIENT_ID,
      });
      if (attemptEpoch !== epoch) throw new Error("Cloud login was cancelled.");
      if (!response.ok) {
        throw new Error(`Cloud login unavailable (${response.status}) at ${server}`);
      }
      const data = (await response.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete?: string;
      };
      if (attemptEpoch !== epoch) throw new Error("Cloud login was cancelled.");
      pending = {
        epoch,
        serverUrl: server,
        ...(relay ? { relayUrl: relay } : {}),
        deviceCode: data.device_code,
      };
      return {
        userCode: data.user_code,
        verificationUri: data.verification_uri_complete ?? data.verification_uri,
      };
    },

    poll() {
      const attempt = pending;
      if (!attempt) return Promise.reject(new Error("No cloud login in progress"));
      if (pollInFlight?.attempt === attempt) return pollInFlight.promise;
      const promise = pollAttempt(attempt).finally(() => {
        if (pollInFlight?.promise === promise) pollInFlight = null;
      });
      pollInFlight = { attempt, promise };
      return promise;
    },

    async status() {
      await storeMutation;
      const credentials = await options.store.load();
      return credentials
        ? {
            connected: true,
            email: credentials.email,
            serverUrl: credentials.serverUrl,
            ...(credentials.relayUrl ? { relayUrl: credentials.relayUrl } : {}),
          }
        : { connected: false };
    },

    async logout() {
      await mutateStore(async () => {
        attemptEpoch += 1;
        pending = null;
        await options.store.clear();
      });
    },

    async credentials() {
      await storeMutation;
      return options.store.load();
    },
  };
}
