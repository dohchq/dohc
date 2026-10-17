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
  saveState(path: string, state: SnapshotJobState): Promise<void>;
  now(): Date;
  log(message: string): void;
}

const initialState = (): SnapshotJobState => ({ version: 1, failingSince: null, lastFailureEmailAt: null, recoveryEmailOwed: false, lastSuccessAt: null });
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function readSnapshotJobState(path: string, log: (message: string) => void): Promise<SnapshotJobState> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as SnapshotJobState;
    const time = (field: string | null) => field === null || (typeof field === "string" && !Number.isNaN(Date.parse(field)));
    if (value?.version === 1 && time(value.failingSince) && time(value.lastFailureEmailAt) && time(value.lastSuccessAt) &&
        typeof value.recoveryEmailOwed === "boolean") return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState(); }
  log("Snapshot notification state was unreadable. It starts again; one extra email can follow.");
  return initialState();
}

export async function saveSnapshotJobState(path: string, state: SnapshotJobState): Promise<void> {
  const partial = `${path}.partial`;
  await writeFile(partial, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flush: true });
  await rename(partial, path);
}

/**
 * The scheduled job. State lives in memory between passes and the file only carries it across
 * restarts, so a disk that refuses the file cannot repeat an email or stop the job.
 */
export function createSnapshotJob(options: SnapshotJobOptions, deps: SnapshotJobDependencies): () => Promise<boolean> {
  let state: SnapshotJobState | undefined;
  const save = async (current: SnapshotJobState) => {
    try { await deps.saveState(options.statePath, current); }
    catch (error) { deps.log(`Snapshot notification state could not be saved. The job keeps it in memory. ${reason(error)}`); }
  };
  // The new limit is saved before the email goes out, so a restart after sending cannot send it again.
  const notify = async (current: SnapshotJobState, reserve: Partial<SnapshotJobState>, message: EmailMessage, retry: string) => {
    const undo = Object.fromEntries(Object.keys(reserve).map(field => [field, current[field as keyof SnapshotJobState]]));
    Object.assign(current, reserve);
    await save(current);
    try { await deps.sendEmail(message); }
    catch (error) {
      Object.assign(current, undo);
      deps.log(`${retry} ${reason(error)}`);
    }
  };

  /** One pass: take a snapshot, then email at most one failure notice a day and one recovery notice. */
  return async () => {
    const current = state ??= await readSnapshotJobState(options.statePath, deps.log);
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
      if (current.recoveryEmailOwed) {
        await notify(current, { recoveryEmailOwed: false }, { to: options.alertEmail, subject: `Relay snapshots work again on ${options.serverName}`,
          text: `The hourly relay snapshot succeeded at ${at}.\nSnapshots had failed since ${current.failingSince ?? "an unknown time"}.\n` },
        "The recovery email could not be sent. The next successful snapshot tries again.");
      }
      // An unsent recovery email keeps the start time for its retry.
      if (!current.recoveryEmailOwed) current.failingSince = null;
      current.lastSuccessAt = at;
      if (options.heartbeatUrl) {
        try { await deps.ping(options.heartbeatUrl); }
        catch (error) { deps.log(`The snapshot heartbeat could not be sent. ${reason(error)}`); }
      }
    } else {
      current.failingSince ??= at;
      const last = current.lastFailureEmailAt === null ? undefined : Date.parse(current.lastFailureEmailAt);
      if (last === undefined || now.getTime() - last >= day) {
        await notify(current, { lastFailureEmailAt: at, recoveryEmailOwed: true }, { to: options.alertEmail,
          subject: `Relay snapshots are failing on ${options.serverName}`,
          text: [`The hourly relay snapshot failed at ${at}.`, `Reason: ${failure}`,
            `Failing since: ${current.failingSince}`, `Last successful snapshot: ${current.lastSuccessAt ?? "none"}`, "",
            "Check the relay-snapshot service logs. You get at most one failure email a day and one email when snapshots work again.", ""].join("\n") },
        "The failure email could not be sent. The next failed snapshot tries again.");
      }
    }
    await save(current);
    return failure === undefined;
  };
}

export async function pingHeartbeat(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`The heartbeat URL returned HTTP ${response.status}.`);
}
