import type { ServerProblemKind } from "@dohc/interface-words/account";
import {
  isApnsDeviceToken,
  type ApnsEnvironment,
  type PushDeviceStatus,
} from "@dohc/workspace-contracts/push-subscriptions";
import { isFields } from "../server/api";
import type { SignIn } from "../server/account";
import { ServerError, shownProblem } from "../server/client";
import type { KeptStore } from "../server/keptStore";
import { bindPushDevice, readPushDevice, removePushDevice } from "../server/pushDevices";
import { readRegistration, saveRegistration } from "../server/pushRegistration";
import type { WorkspaceList } from "../server/workspaceList";

export type Permission = "granted" | "denied" | "undetermined";

/** What the alerts need of the operating system. */
export interface NativeAlerts {
  permission(): Promise<Permission>;
  ask(): Promise<Permission>;
  token(): Promise<string>;
  onToken(listener: () => void): () => void;
}

/**
 * `unavailable`: the server sends no alerts. `ready`: `on` once the person turned alerts on and the system allows them;
 * `denied` when they turned them on and the system doesn't. `problem` is the last change's failure: the server's, or
 * `kept` when this phone couldn't save it.
 */
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
  /** Brings the server's binding in line with the choice and the system's permission. */
  sync(): Promise<void>;
  turnOn(): void;
  turnOff(): void;
  stop(): void;
}

const READY = { status: "ready", on: false, denied: false, busy: false, problem: null } as const;

/** One sign-in's alerts: its row in kept.db, the system's permission, and the server's binding for its session. */
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
  let generation: number | null = null;
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
    await saveRegistration(store, owner, alerts, next);
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
      const token = await native.token();
      if (!live()) return;
      if (!isApnsDeviceToken(token)) throw new ServerError("invalid");
      status = await bindPushDevice(
        signIn.client,
        { token, environment: options.environment },
        controller.signal,
      );
    } else if (status.available && status.enabled) {
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

  async function change(alerts: boolean) {
    if (!live() || state.status !== "ready" || state.busy) return;
    ready({ busy: true });
    try {
      if (alerts) await native.ask().catch(() => undefined);
      await save(alerts, generation);
    } catch {
      return ready({ busy: false, problem: "kept" });
    }
    await sync();
  }

  const stopToken = native.onToken(() => void sync());
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    generation: () => generation,
    sync,
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

/**
 * Where a tapped alert opens: its message, when the alert names the binding the server last acknowledged for this
 * sign-in, and the workspace shows on this phone. Null sends the tap to Home.
 */
export function alertTarget(
  data: unknown,
  generation: number | null,
  list: WorkspaceList,
): AlertTarget | null {
  if (!isFields(data) || generation === null || data.generation !== generation) return null;
  const { workspaceId, threadId, messageId } = data;
  if (!id(workspaceId) || !id(threadId) || !id(messageId)) return null;
  if (list.status !== "ready" || list.pending.has(workspaceId)) return null;
  const entry = list.workspaces.find((item) => item.workspaceId === workspaceId);
  return entry?.showOnPhone && entry.canOpen ? { workspaceId, threadId, messageId } : null;
}
