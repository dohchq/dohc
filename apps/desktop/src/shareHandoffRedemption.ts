import type {
  ShareHandoffCode,
  ShareHandoffIntentSlot,
} from "./shareHandoffIngress";

export type ShareHandoffStatus =
  | { status: "idle" }
  | { status: "waiting-for-sign-in" }
  | { status: "redeeming" }
  | { status: "failed-refused" }
  | { status: "failed-network" }
  | { status: "done"; shareId: string };

export interface ShareHandoffCredentials {
  serverUrl: string;
  relayUrl?: string;
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
  retry(): void;
  dismiss(): void;
}

type ShareHandoffFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ShareHandoffRedemptionOptions {
  intent: Pick<ShareHandoffIntentSlot, "snapshot" | "settle">;
  credentialSnapshot(): ShareHandoffCredentialSnapshot;
  fetch: ShareHandoffFetch;
  handleUnauthorized(credentials: ShareHandoffCredentials): Promise<boolean>;
  publishStatus(status: ShareHandoffStatus): void;
}

interface RedeemSuccess {
  shareId: string;
}

function sameStatus(
  left: ShareHandoffStatus,
  right: ShareHandoffStatus,
): boolean {
  return (
    left.status === right.status &&
    (left.status !== "done" ||
      (right.status === "done" && left.shareId === right.shareId))
  );
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
  let automaticAttemptKey: string | null = null;
  const activeAttemptKeys = new Set<string>();

  function publish(status: ShareHandoffStatus): void {
    if (sameStatus(publicStatus, status)) return;
    publicStatus = status;
    options.publishStatus(status);
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

  function beginCurrent(optionsForAttempt: { retry: boolean }): void {
    const pending = options.intent.snapshot();
    if (pending.code === null) return;
    const credentialSnapshot = options.credentialSnapshot();
    const credentials = credentialSnapshot.credentials;
    if (!credentials?.relayUrl) {
      publish({ status: "waiting-for-sign-in" });
      return;
    }

    const attemptKey = `${pending.generation}:${credentialSnapshot.generation}`;
    if (activeAttemptKeys.has(attemptKey)) return;
    if (!optionsForAttempt.retry && automaticAttemptKey === attemptKey) return;
    if (!optionsForAttempt.retry) automaticAttemptKey = attemptKey;
    activeAttemptKeys.add(attemptKey);
    publish({ status: "redeeming" });
    void redeem({
      code: pending.code,
      pendingGeneration: pending.generation,
      credentials,
      credentialGeneration: credentialSnapshot.generation,
    }).finally(() => {
      activeAttemptKeys.delete(attemptKey);
    });
  }

  async function redeem(input: {
    code: ShareHandoffCode;
    pendingGeneration: number;
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
        publish({ status: "failed-network" });
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
        publish({ status: "waiting-for-sign-in" });
      }
      return;
    }

    if (
      !isCurrentCompletion(input.pendingGeneration, input.credentialGeneration)
    ) {
      return;
    }

    if (response.status >= 400 && response.status < 500) {
      options.intent.settle(input.code);
      publish({ status: "failed-refused" });
      return;
    }
    if (!response.ok) {
      publish({ status: "failed-network" });
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
      publish({ status: "failed-network" });
      return;
    }

    options.intent.settle(input.code);
    publish({ status: "done", shareId: success.shareId });
  }

  return {
    status() {
      return publicStatus;
    },
    pendingCodeChanged() {
      beginCurrent({ retry: false });
    },
    credentialsChanged() {
      beginCurrent({ retry: false });
    },
    retry() {
      if (publicStatus.status !== "failed-network") return;
      beginCurrent({ retry: true });
    },
    dismiss() {
      const pending = options.intent.snapshot();
      if (pending.code !== null) options.intent.settle(pending.code);
      publish({ status: "idle" });
    },
  };
}
