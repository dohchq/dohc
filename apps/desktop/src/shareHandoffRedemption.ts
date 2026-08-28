import type {
  ShareHandoffCode,
  ShareHandoffIntentSlot,
} from "./shareHandoffIngress";

export type ShareHandoffStatus =
  | { status: "idle" }
  | { status: "waiting-for-sign-in"; statusId: string }
  | { status: "waiting-for-acceptance"; statusId: string; email: string }
  | { status: "redeeming"; statusId: string }
  | { status: "failed-refused"; statusId: string }
  | { status: "failed-busy"; statusId: string }
  | { status: "failed-network"; statusId: string }
  | { status: "done"; statusId: string; shareId: string };

export interface ShareHandoffCredentials {
  serverUrl: string;
  relayUrl?: string;
  email: string;
  token: string;
  userId: string;
}

export interface ShareHandoffCredentialSnapshot {
  credentials: ShareHandoffCredentials | null;
  generation: number;
}

export interface ShareHandoffRedemptionCoordinator {
  status(): ShareHandoffStatus;
  pendingCodeChanged(): void;
  credentialsChanged(): void;
  accept(statusId: string): void;
  retry(): void;
  dismiss(statusId: string): void;
}

type ShareHandoffFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ShareHandoffRedemptionOptions {
  intent: Pick<ShareHandoffIntentSlot, "snapshot" | "settle">;
  createStatusId(): string;
  credentialSnapshot(): ShareHandoffCredentialSnapshot;
  fetch: ShareHandoffFetch;
  handleUnauthorized(credentials: ShareHandoffCredentials): Promise<boolean>;
  publishStatus(status: ShareHandoffStatus): void;
}

interface RedeemSuccess {
  shareId: string;
}

interface VisibleIdentity {
  pendingGeneration: number;
  credentialGeneration: number;
  statusId: string;
}

function sameStatus(
  left: ShareHandoffStatus,
  right: ShareHandoffStatus,
): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "idle") return true;
  if (right.status === "idle" || left.statusId !== right.statusId) return false;
  if (left.status === "done") {
    return right.status === "done" && left.shareId === right.shareId;
  }
  if (left.status === "waiting-for-acceptance") {
    return (
      right.status === "waiting-for-acceptance" && left.email === right.email
    );
  }
  return true;
}

function ordinaryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function redeemSuccess(value: unknown): RedeemSuccess | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    body.ok !== true ||
    !ordinaryId(body.shareId) ||
    !ordinaryId(body.grantId) ||
    body.access !== "view"
  ) {
    return null;
  }
  return { shareId: body.shareId };
}

function relayRedeemUrl(relayUrl: string): string {
  return `${relayUrl.replace(/\/+$/u, "")}/sync/link-redeem`;
}

export function createShareHandoffRedemptionCoordinator(
  options: ShareHandoffRedemptionOptions,
): ShareHandoffRedemptionCoordinator {
  let publicStatus: ShareHandoffStatus = { status: "idle" };
  let visibleIdentity: VisibleIdentity | null = null;
  let acceptedIdentity: VisibleIdentity | null = null;
  const activeAttemptKeys = new Set<string>();

  function publish(status: ShareHandoffStatus): void {
    if (sameStatus(publicStatus, status)) return;
    publicStatus = status;
    options.publishStatus(status);
  }

  function statusIdFor(
    pendingGeneration: number,
    credentialGeneration: number,
  ): string {
    if (
      visibleIdentity?.pendingGeneration === pendingGeneration &&
      visibleIdentity.credentialGeneration === credentialGeneration
    ) {
      return visibleIdentity.statusId;
    }
    const statusId = options.createStatusId();
    if (!ordinaryId(statusId)) {
      throw new Error("Share handoff status identity must be 1 to 200 characters.");
    }
    visibleIdentity = { pendingGeneration, credentialGeneration, statusId };
    acceptedIdentity = null;
    return statusId;
  }

  function isCurrentCompletion(
    pendingGeneration: number,
    credentialGeneration: number,
  ): boolean {
    return (
      options.intent.snapshot().generation === pendingGeneration &&
      options.credentialSnapshot().generation === credentialGeneration
    );
  }

  function currentAttempt(statusId: string): {
    code: ShareHandoffCode;
    pendingGeneration: number;
    statusId: string;
    credentials: ShareHandoffCredentials;
    credentialGeneration: number;
  } | null {
    const pending = options.intent.snapshot();
    if (pending.code === null) return null;
    const credentialSnapshot = options.credentialSnapshot();
    const credentials = credentialSnapshot.credentials;
    const identity = visibleIdentity;
    if (
      !credentials?.relayUrl ||
      identity?.statusId !== statusId ||
      identity.pendingGeneration !== pending.generation ||
      identity.credentialGeneration !== credentialSnapshot.generation
    ) {
      return null;
    }
    return {
      code: pending.code,
      pendingGeneration: pending.generation,
      statusId,
      credentials,
      credentialGeneration: credentialSnapshot.generation,
    };
  }

  function beginRedemption(
    input: NonNullable<ReturnType<typeof currentAttempt>>,
  ): void {
    const attemptKey = `${input.pendingGeneration}:${input.credentialGeneration}`;
    if (activeAttemptKeys.has(attemptKey)) return;
    activeAttemptKeys.add(attemptKey);
    publish({ status: "redeeming", statusId: input.statusId });
    void redeem(input).finally(() => {
      activeAttemptKeys.delete(attemptKey);
    });
  }

  function showCurrent(): void {
    const pending = options.intent.snapshot();
    if (pending.code === null) return;
    const credentialSnapshot = options.credentialSnapshot();
    if (
      visibleIdentity?.pendingGeneration === pending.generation &&
      visibleIdentity.credentialGeneration === credentialSnapshot.generation &&
      publicStatus.status !== "idle" &&
      publicStatus.statusId === visibleIdentity.statusId
    ) {
      return;
    }
    const statusId = statusIdFor(
      pending.generation,
      credentialSnapshot.generation,
    );
    const credentials = credentialSnapshot.credentials;
    if (!credentials?.relayUrl) {
      publish({ status: "waiting-for-sign-in", statusId });
      return;
    }
    publish({
      status: "waiting-for-acceptance",
      statusId,
      email: credentials.email,
    });
  }

  async function redeem(input: {
    code: ShareHandoffCode;
    pendingGeneration: number;
    statusId: string;
    credentials: ShareHandoffCredentials;
    credentialGeneration: number;
  }): Promise<void> {
    let response: Response;
    try {
      response = await options.fetch(relayRedeemUrl(input.credentials.relayUrl!), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${input.credentials.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ code: input.code }),
      });
    } catch {
      if (
        isCurrentCompletion(
          input.pendingGeneration,
          input.credentialGeneration,
        )
      ) {
        publish({ status: "failed-network", statusId: input.statusId });
      }
      return;
    }

    if (response.status === 401) {
      if (
        !isCurrentCompletion(
          input.pendingGeneration,
          input.credentialGeneration,
        )
      ) {
        return;
      }
      const sessionWasCurrent = await options.handleUnauthorized(
        input.credentials,
      );
      if (
        sessionWasCurrent &&
        options.intent.snapshot().generation === input.pendingGeneration &&
        options.credentialSnapshot().credentials === null
      ) {
        showCurrent();
      }
      return;
    }

    if (
      !isCurrentCompletion(input.pendingGeneration, input.credentialGeneration)
    ) {
      return;
    }

    if (response.status === 429) {
      publish({ status: "failed-busy", statusId: input.statusId });
      return;
    }
    if (response.status >= 400 && response.status < 500) {
      options.intent.settle(input.code);
      visibleIdentity = null;
      acceptedIdentity = null;
      publish({ status: "failed-refused", statusId: input.statusId });
      return;
    }
    if (!response.ok) {
      publish({ status: "failed-network", statusId: input.statusId });
      return;
    }

    const body = await response.json().catch(() => null);
    if (
      !isCurrentCompletion(input.pendingGeneration, input.credentialGeneration)
    ) {
      return;
    }
    const success = redeemSuccess(body);
    if (success === null) {
      publish({ status: "failed-network", statusId: input.statusId });
      return;
    }

    options.intent.settle(input.code);
    visibleIdentity = null;
    acceptedIdentity = null;
    publish({ status: "done", statusId: input.statusId, shareId: success.shareId });
  }

  return {
    status() {
      return publicStatus;
    },
    pendingCodeChanged() {
      showCurrent();
    },
    credentialsChanged() {
      visibleIdentity = null;
      acceptedIdentity = null;
      showCurrent();
    },
    accept(statusId) {
      if (
        publicStatus.status !== "waiting-for-acceptance" ||
        publicStatus.statusId !== statusId
      ) {
        return;
      }
      const input = currentAttempt(statusId);
      if (!input || input.credentials.email !== publicStatus.email) return;
      acceptedIdentity = {
        pendingGeneration: input.pendingGeneration,
        credentialGeneration: input.credentialGeneration,
        statusId: input.statusId,
      };
      beginRedemption(input);
    },
    retry() {
      if (
        publicStatus.status !== "failed-network" &&
        publicStatus.status !== "failed-busy"
      ) {
        return;
      }
      const input = currentAttempt(publicStatus.statusId);
      if (
        !input ||
        acceptedIdentity?.statusId !== input.statusId ||
        acceptedIdentity.pendingGeneration !== input.pendingGeneration ||
        acceptedIdentity.credentialGeneration !== input.credentialGeneration
      ) {
        return;
      }
      beginRedemption(input);
    },
    dismiss(statusId) {
      if (publicStatus.status === "idle" || publicStatus.statusId !== statusId) {
        return;
      }
      const pending = options.intent.snapshot();
      if (
        pending.code !== null &&
        visibleIdentity?.pendingGeneration === pending.generation &&
        visibleIdentity.statusId === statusId
      ) {
        options.intent.settle(pending.code);
      }
      visibleIdentity = null;
      acceptedIdentity = null;
      publish({ status: "idle" });
    },
  };
}
