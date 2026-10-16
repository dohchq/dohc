import { readFile, rename, writeFile } from "node:fs/promises";
import type { EmailMessage } from "@dohc/workspace-auth/smtp";

const day = 24 * 60 * 60 * 1000;

/** Notification memory survives restarts so a crash loop cannot repeat the failure email. */
export interface SnapshotJobState {
  version: 1;
  failingSince: string | null;
  lastFailureEmailAt: string | null;
  /** A failure email went out and no recovery email has followed it yet. */
  recoveryEmailOwed: boolean;
  lastSuccessAt: string | null;
}

export interface SnapshotJobOptions {
  statePath: string;
  alertEmail: string;
  serverName: string;
  heartbeatUrl?: string;
}

export interface SnapshotJobDependencies {
  snapshot(): Promise<string>;
  sendEmail(message: EmailMessage): Promise<void>;
  ping(url: string): Promise<void>;
  now(): Date;
  log(message: string): void;
}

const initialState = (): SnapshotJobState => ({ version: 1, failingSince: null, lastFailureEmailAt: null, recoveryEmailOwed: false, lastSuccessAt: null });

export async function readSnapshotJobState(path: string, log: (message: string) => void): Promise<SnapshotJobState> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState(); throw error; }
  try {
    const value = JSON.parse(text) as SnapshotJobState;
    const time = (field: string | null) => field === null || (typeof field === "string" && !Number.isNaN(Date.parse(field)));
    if (value?.version === 1 && time(value.failingSince) && time(value.lastFailureEmailAt) && time(value.lastSuccessAt) &&
        typeof value.recoveryEmailOwed === "boolean") return value;
  } catch {}
  log("Snapshot notification state was unreadable. It starts again; one extra email can follow.");
  return initialState();
}

async function writeState(path: string, state: SnapshotJobState): Promise<void> {
  const partial = `${path}.partial`;
  await writeFile(partial, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flush: true });
  await rename(partial, path);
}

/** One scheduled pass: take a snapshot, then email at most one failure notice a day and one recovery notice. */
export async function runSnapshotJobOnce(options: SnapshotJobOptions, deps: SnapshotJobDependencies): Promise<boolean> {
  const state = await readSnapshotJobState(options.statePath, deps.log);
  const now = deps.now(), at = now.toISOString();
  let failure: string | undefined;
  try {
    const name = await deps.snapshot();
    deps.log(`Relay snapshot uploaded: ${name}`);
  } catch (error) {
    failure = error instanceof Error && error.message ? error.message : "The snapshot failed without a reason.";
    deps.log(`Relay snapshot failed: ${failure}`);
  }
  if (failure === undefined) {
    if (state.recoveryEmailOwed) {
      try {
        await deps.sendEmail({ to: options.alertEmail, subject: `Relay snapshots work again on ${options.serverName}`,
          text: `The hourly relay snapshot succeeded at ${at}.\nSnapshots had failed since ${state.failingSince ?? "an unknown time"}.\n` });
        state.recoveryEmailOwed = false;
      } catch (error) { deps.log(`The recovery email could not be sent. The next successful snapshot tries again. ${(error as Error).message}`); }
    }
    state.failingSince = null;
    state.lastSuccessAt = at;
    if (options.heartbeatUrl) {
      try { await deps.ping(options.heartbeatUrl); }
      catch (error) { deps.log(`The snapshot heartbeat could not be sent. ${(error as Error).message}`); }
    }
  } else {
    state.failingSince ??= at;
    const last = state.lastFailureEmailAt === null ? undefined : Date.parse(state.lastFailureEmailAt);
    if (last === undefined || now.getTime() - last >= day) {
      try {
        await deps.sendEmail({ to: options.alertEmail, subject: `Relay snapshots are failing on ${options.serverName}`,
          text: [`The hourly relay snapshot failed at ${at}.`, `Reason: ${failure}`,
            `Failing since: ${state.failingSince}`, `Last successful snapshot: ${state.lastSuccessAt ?? "none"}`, "",
            "Check the relay-snapshot service logs. You get at most one failure email a day and one email when snapshots work again.", ""].join("\n") });
        state.lastFailureEmailAt = at;
        state.recoveryEmailOwed = true;
      } catch (error) { deps.log(`The failure email could not be sent. The next failed snapshot tries again. ${(error as Error).message}`); }
    }
  }
  await writeState(options.statePath, state);
  return failure === undefined;
}

export async function pingHeartbeat(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`The heartbeat URL returned HTTP ${response.status}.`);
}
