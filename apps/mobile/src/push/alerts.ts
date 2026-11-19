import type { ServerProblemKind } from "@dohc/interface-words/account";
import {
  isApnsDeviceToken,
  type ApnsEnvironment,
  type PushDeviceStatus,
} from "@dohc/workspace-contracts/push-subscriptions";
import { isFields, listWorkspaces, type AccountWorkspace } from "../server/api";
import type { SignIn } from "../server/account";
import { ServerError, shownProblem } from "../server/client";
import type { KeptStore } from "../server/keptStore";
import { bindPushDevice, readPushDevice, removePushDevice } from "../server/pushDevices";
import { readRegistration, saveRegistration } from "../server/pushRegistration";

export type Permission = "granted" | "denied" | "undetermined";

export interface NativeAlerts {
  permission(): Promise<Permission>;
  ask(): Promise<Permission>;
  token(): Promise<string>;
  onToken(listener: (token: string) => void): () => void;
}

/** `problem` is `kept` when this phone couldn't save the choice. */
export type AlertsState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly on: boolean;
      readonly denied: boolean;
      readonly busy: boolean;
      readonly problem: ServerProblemKind | "kept" | null;
    };

export interface Alerts {
  state(): AlertsState;
  subscribe(listener: () => void): () => void;
  /** The binding the server last acknowledged for this sign-in, or null. */
  generation(): number | null;
  sync(): Promise<void>;
  /** Saves a choice that failed to save, then syncs. */
  retry(): void;
  turnOn(): void;
  turnOff(): void;
  stop(): void;
}

const READY = { status: "ready", on: false, denied: false, busy: false, problem: null } as const;

export function createAlerts(options: {
  readonly signIn: SignIn;
  readonly store: KeptStore;
  readonly native: NativeAlerts;
  readonly environment: ApnsEnvironment;
}): Alerts {
  const { signIn, store, native } = options;
  const owner = { origin: signIn.origin, userId: signIn.userId };
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  let state: AlertsState = { status: "loading" };
  let wanted: boolean | null = null;
  let requested: boolean | null = null;
  let generation: number | null = null;
  let latest: string | null = null;
  let pushed: string | null = null;
  let fetching = false;
  let running = false;
  let again = false;
  const live = () => !controller.signal.aborted && signIn.isCurrent();

  function set(next: AlertsState) {
    if (!live()) return;
    state = next;
    for (const listener of listeners) listener();
  }

  const ready = (change: Partial<Extract<AlertsState, { status: "ready" }>>) =>
    set({ ...(state.status === "ready" ? state : READY), ...change });

  async function save(alerts: boolean, next: number | null) {
    if (alerts === wanted && next === generation) return;
    await saveRegistration(store, owner, alerts, next, live);
    if (!live()) return;
    wanted = alerts;
    generation = next;
  }

  async function reconcile(): Promise<void> {
    if (wanted === null) {
      const row = await readRegistration(store, owner);
      if (!live() || row?.signingOut) return;
      wanted = row?.alerts ?? false;
      generation = row?.generation ?? null;
    }
    const permission = await native.permission();
    if (!live()) return;
    let status: PushDeviceStatus = await readPushDevice(signIn.client, controller.signal);
    if (!live()) return;
    if (!status.available) return set({ status: "unavailable" });
    const want = wanted && permission === "granted";
    if (want) {
      fetching = pushed === null;
      const token = pushed ?? (await native.token().finally(() => (fetching = false)));
      pushed = null;
      if (!live()) return;
      latest = token;
      if (!isApnsDeviceToken(token)) throw new ServerError("invalid");
      status = await bindPushDevice(
        signIn.client,
        { token, environment: options.environment },
        controller.signal,
      );
    } else if (status.enabled) {
      status = await removePushDevice(signIn.client, status.generation, controller.signal);
    }
    if (!live()) return;
    await save(wanted, status.available && status.enabled ? status.generation : null);
    ready({ on: want, denied: wanted && permission === "denied", problem: null });
  }

  async function sync(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        try {
          await reconcile();
        } catch (error) {
          const problem = error instanceof ServerError ? shownProblem(error) : "kept";
          if (problem !== null)
            ready({ problem, ...(state.status === "ready" ? {} : { on: wanted === true }) });
        }
      } while (again && live());
    } finally {
      running = false;
      if (state.status === "ready") ready({ busy: false });
    }
  }

  async function change(alerts: boolean | null) {
    if (!live() || state.status !== "ready" || state.busy) return;
    if (alerts !== null) requested = alerts;
    ready({ busy: true });
    try {
      if (requested !== null) {
        if (requested) await native.ask().catch(() => undefined);
        if (!live()) return;
        await save(requested, generation);
        if (!live()) return;
        requested = null;
      }
    } catch {
      return ready({ busy: false, problem: "kept" });
    }
    await sync();
  }

  const stopToken = native.onToken((token) => {
    if (fetching || token === latest) return;
    latest = pushed = token;
    void sync();
  });
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    generation: () => generation,
    sync,
    retry: () => void change(null),
    turnOn: () => void change(true),
    turnOff: () => void change(false),
    stop() {
      controller.abort();
      stopToken();
    },
  };
}

export interface AlertTarget {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly messageId: string;
}

const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export function alertTarget(
  data: unknown,
  generation: number | null,
  workspaces: readonly AccountWorkspace[],
): AlertTarget | null {
  if (!isFields(data) || generation === null || data.generation !== generation) return null;
  const { workspaceId, threadId, messageId } = data;
  if (!id(workspaceId) || !id(threadId) || !id(messageId)) return null;
  const entry = workspaces.find((item) => item.workspaceId === workspaceId);
  return entry?.showOnPhone && entry.canOpen ? { workspaceId, threadId, messageId } : null;
}

/** Reads the workspaces from the server first. Null when the sign-in changed; a problem to retry when offline. */
export async function openTap(
  signIn: SignIn,
  data: unknown,
  generation: () => number | null,
): Promise<AlertTarget | "home" | "offline" | "server-busy" | null> {
  try {
    const workspaces = await listWorkspaces(signIn.client);
    if (!signIn.isCurrent()) return null;
    return alertTarget(data, generation(), workspaces) ?? "home";
  } catch (error) {
    const problem = shownProblem(error);
    if (!signIn.isCurrent() || problem === null) return null;
    return problem === "offline" || problem === "server-busy" ? problem : "home";
  }
}
