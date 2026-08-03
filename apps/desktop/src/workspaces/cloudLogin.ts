import { createHash } from "node:crypto";
import type { CloudCredentials } from "./cloudCredentialStore";

// Desktop side of the OAuth device-authorization flow against dohc Cloud (or
// a self-host server): start() asks the server for a short user code, the
// user approves it in the system browser, poll() exchanges the device code
// for a session token once approved. The token is persisted via the injected
// store (safeStorage-encrypted in production) and NEVER returned to callers —
// the renderer only ever sees status + email.

const CLIENT_ID = "dohc-desktop";

// The invalid-session marker: a session the relay proved dead whose
// credential record could not be deleted. It persists across restarts so the
// dead record can never be read back as connected, and it holds a token
// HASH, never the token.
export interface InvalidSessionMarker {
  serverUrl: string;
  userId: string;
  tokenHash: string;
}

export interface CloudLoginStore {
  load(): Promise<CloudCredentials | null>;
  save(credentials: CloudCredentials): Promise<void>;
  clear(): Promise<void>;
  loadInvalidMarker(): Promise<InvalidSessionMarker | null>;
  saveInvalidMarker(marker: InvalidSessionMarker): Promise<void>;
  clearInvalidMarker(): Promise<void>;
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
  // Atomically clear the saved session ONLY while it still matches the given
  // identity. Runs inside the store's mutation queue, so a login save cannot
  // land between the compare and the clear — a 401 from an outgoing session
  // can never delete a login that just completed. Unlike logout, it does not
  // cancel an in-progress login attempt: the attempt belongs to the NEXT
  // session, not the dead one.
  invalidateSessionIf(expected: {
    serverUrl: string;
    userId: string;
    token: string;
  }): Promise<void>;
  // The persisted token for the sync engine (main-process only — never IPC).
  credentials(): Promise<CloudCredentials | null>;
}

export interface CompletedCloudLoginSessionOptions {
  clearCachedCredentials(): void;
  stopEngines(): Promise<void>;
  closeRelayTransportWorkspaces(): Promise<void>;
  refreshCredentialCache(): Promise<void>;
  reconcileCloud(): void;
  // The immediate broadcast, fired at the clear, BEFORE cleanup that can
  // stall. The caller computes the INCOMING session's identity before this
  // transition starts and sends that — never a signed-out interim, which a
  // same-account rotation would read as a switch and clear rows the
  // same-key rule exists to preserve.
  notifySessionChanging(): void;
  // The final broadcast, fired once the new credentials are adopted (or the
  // transition failed): it carries the session's actual final state.
  notifyCloudSessionChanged(): void;
}

export async function adoptCompletedCloudLoginSession(
  options: CompletedCloudLoginSessionOptions,
): Promise<void> {
  options.clearCachedCredentials();
  options.notifySessionChanging();
  try {
    await adoptCredentialTransition(options);
  } finally {
    options.notifyCloudSessionChanged();
  }
}

async function adoptCredentialTransition(
  options: CompletedCloudLoginSessionOptions,
): Promise<void> {
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

export interface CloudLogoutTransitionOptions {
  clearCachedCredentials(): void;
  logout(): Promise<void>;
  stopEngines(): Promise<void>;
  closeRelayTransportWorkspaces(): Promise<void>;
  notifyWorkspaceActivity(): void;
  notifyCloudSessionChanged(): void;
}

// The logout transition. The session is invalid the moment the cached
// credentials are cleared, so the session signal fires right there — before
// the credential store and before engine cleanup, either of which can reject
// or stall indefinitely behind an in-flight sync pass. Mounted views re-scope
// on the signal, never on cleanup finishing.
export async function runCloudLogoutTransition(
  options: CloudLogoutTransitionOptions,
): Promise<void> {
  options.clearCachedCredentials();
  options.notifyCloudSessionChanged();
  try {
    await options.logout();
  } finally {
    try {
      // Stop + drop active engines even if the credential store reports a
      // logout failure. The in-memory session is already invalid.
      await options.stopEngines();
      await options.closeRelayTransportWorkspaces();
    } finally {
      options.notifyWorkspaceActivity();
    }
  }
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
  // An invalid-session tombstone: a session the relay proved dead whose
  // persistent record could not be deleted. status() and credentials()
  // honor it until a deletion succeeds — no surface may report connected
  // from a record the session layer knows is dead.
  let invalidatedSession: {
    serverUrl: string;
    userId: string;
    token: string;
  } | null = null;
  function matchesInvalidatedSession(
    credentials: CloudCredentials | null,
  ): boolean {
    return (
      invalidatedSession !== null &&
      credentials !== null &&
      credentials.token === invalidatedSession.token &&
      credentials.serverUrl === invalidatedSession.serverUrl &&
      credentials.userId === invalidatedSession.userId
    );
  }
  function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
  function markerFor(session: {
    serverUrl: string;
    userId: string;
    token: string;
  }): InvalidSessionMarker {
    return {
      serverUrl: session.serverUrl,
      userId: session.userId,
      tokenHash: hashToken(session.token),
    };
  }
  // Dead by the in-memory tombstone OR by the PERSISTED marker — the marker
  // is what survives a restart while the store still holds the dead record.
  async function sessionIsDead(credentials: CloudCredentials): Promise<boolean> {
    if (matchesInvalidatedSession(credentials)) return true;
    const marker = await options.store.loadInvalidMarker().catch(() => null);
    return (
      marker !== null &&
      marker.serverUrl === credentials.serverUrl &&
      marker.userId === credentials.userId &&
      marker.tokenHash === hashToken(credentials.token)
    );
  }
  // Deleted-on-load: before any surface accepts a stored session that the
  // marker names dead, retry the deletion that failed last time.
  async function retryInvalidatedDeletion(dead: CloudCredentials): Promise<void> {
    await mutateStore(async () => {
      const saved = await options.store.load();
      if (
        saved === null ||
        saved.token !== dead.token ||
        saved.serverUrl !== dead.serverUrl ||
        saved.userId !== dead.userId
      ) {
        return;
      }
      await options.store.clear();
      invalidatedSession = null;
      await options.store.clearInvalidMarker().catch(() => undefined);
    });
  }
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
      if (credentials === null) return { connected: false };
      if (await sessionIsDead(credentials)) {
        await retryInvalidatedDeletion(credentials).catch(() => undefined);
        return { connected: false };
      }
      return {
        connected: true,
        email: credentials.email,
        serverUrl: credentials.serverUrl,
        ...(credentials.relayUrl ? { relayUrl: credentials.relayUrl } : {}),
      };
    },

    async logout() {
      await mutateStore(async () => {
        attemptEpoch += 1;
        pending = null;
        await options.store.clear();
        // The record is gone; a marker for it has nothing left to name.
        invalidatedSession = null;
        await options.store.clearInvalidMarker().catch(() => undefined);
      });
    },

    async invalidateSessionIf(expected) {
      await mutateStore(async () => {
        const saved = await options.store.load();
        if (
          saved === null ||
          saved.token !== expected.token ||
          saved.serverUrl !== expected.serverUrl ||
          saved.userId !== expected.userId
        ) {
          return;
        }
        try {
          await options.store.clear();
          invalidatedSession = null;
          await options.store.clearInvalidMarker().catch(() => undefined);
        } catch (error) {
          // Deletion failed, but the session is still dead: hold the
          // in-memory tombstone AND persist the marker (best-effort), so
          // even a restart cannot read the dead record back as connected.
          // Fail loudly — the next read or invalidation retries the
          // deletion.
          invalidatedSession = expected;
          await options.store
            .saveInvalidMarker(markerFor(expected))
            .catch(() => undefined);
          throw error;
        }
      });
    },

    async credentials() {
      await storeMutation;
      const loaded = await options.store.load();
      if (loaded === null) return null;
      // A tombstoned record is a dead session: handing it out would let a
      // sync engine retry the dead token as if it were live.
      if (await sessionIsDead(loaded)) {
        await retryInvalidatedDeletion(loaded).catch(() => undefined);
        return null;
      }
      return loaded;
    },
  };
}
