import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  PluginChildProcessClient,
  PluginChildProcessHandle,
  PluginWebAppStart,
} from "@dohc/sdk/node";
import {
  createStreamLineBuffer,
  findPairingUrl,
  redactT3Output,
} from "./accessBlock";
import { allocateLoopbackPort } from "./ports";
import {
  pollT3Readiness,
  T3ChildExitError,
  type PollT3ReadinessInput,
} from "./readiness";
import {
  clearOwnerRecord,
  recoverStaleState,
  T3_OWNER_FILE_NAME,
  writeOwnerRecord,
} from "./staleState";
import { resolveT3Entry } from "./t3Entry";

// One t3 server per canonical workspace root: t3 checkpoint refs live in the
// workspace's own git repository (refs/t3/checkpoints), so two servers on one
// root would fight over them — the spike measured it. The plugin host runs
// one activation per workspace, and this bridge single-flights the spawn
// within it.

export const T3_WEB_APP_ID = "app";

// Allocate-then-bind is a real race; the spike's contract is to retry a
// failed bind with a fresh port. Three attempts covers the race without
// masking a server that genuinely cannot start.
const SPAWN_ATTEMPT_LIMIT = 3;
// The SDK's default request timeout (10 s) would end a wait() on a server
// meant to run for the whole session; this is setTimeout's ceiling (~24.8
// days), the closest thing to "until it exits".
const CHILD_WAIT_TIMEOUT_MS = 2_147_483_647;
const RAW_BUFFER_LIMIT = 16_384;
const RECENT_LOG_LIMIT = 20;

export interface T3BridgeContext {
  pluginRoot: string;
  workspaceRoot: string;
  stateRoot: string;
  childProcesses: PluginChildProcessClient;
}

export interface T3BridgeOptions {
  /** Receives redacted lines only; the bridge redacts before calling it. */
  log?: (line: string) => void;
  readiness?: Pick<
    PollT3ReadinessInput,
    "fetchFn" | "intervalMs" | "requestTimeoutMs" | "overallTimeoutMs"
  >;
}

export interface T3Bridge {
  startWebApp(webAppId: string): Promise<PluginWebAppStart>;
  stopWebApp(webAppId: string): Promise<void>;
  dispose(): Promise<void>;
}

interface ReadyServer {
  origin: string;
  /** Held in memory only. Never logged, never persisted, never in an error. */
  pairingUrl: string;
  child: PluginChildProcessHandle;
  ownerPath: string;
  alive: boolean;
  paired: boolean;
}

export function createT3Bridge(
  ctx: T3BridgeContext,
  options: T3BridgeOptions = {},
): T3Bridge {
  const recentLines: string[] = [];
  const log = (line: string): void => {
    recentLines.push(line);
    if (recentLines.length > RECENT_LOG_LIMIT) recentLines.shift();
    (options.log ?? ((text: string) => console.error(`[t3-code] ${text}`)))(line);
  };

  let serverPromise: Promise<ReadyServer> | null = null;
  let disposed = false;

  async function spawnAttempt(
    entry: string,
    baseDir: string,
    ownerPath: string,
    port: number,
  ): Promise<ReadyServer | null> {
    const child = await ctx.childProcesses.spawn({
      modulePath: entry,
      args: [
        "serve",
        "--mode",
        "web",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--base-dir",
        baseDir,
        ctx.workspaceRoot,
      ],
      cwd: { workspaceRoot: true },
      env: {
        T3CODE_NO_BROWSER: "1",
        T3CODE_TELEMETRY_ENABLED: "false",
        NO_COLOR: "1",
      },
    });
    // Armed before readiness, not after it. A crash inside the spawn-to-ready
    // window would otherwise leave a live t3 server no later start may signal
    // — the recovery reads no owner, so it only deletes the file and the
    // orphan keeps the workspace's checkpoint refs. Both fields are known
    // here: the port was allocated before the spawn, the pid comes back with
    // the handle.
    const pid = child.pid;
    if (pid !== null) await writeOwnerRecord(ownerPath, { pid, port });
    /**
     * Ends a failed attempt's child and disarms its record — but only once
     * this plugin has done everything it can to end the process the record
     * names. A terminate that did not resolve leaves a child that may still
     * hold the port and the workspace's checkpoint refs, and the record is
     * what lets the next start probe and signal it.
     */
    const endFailedAttempt = async (alreadyGone = false): Promise<void> => {
      const gone =
        alreadyGone ||
        (await child.terminate().then(
          () => true,
          () => false,
        ));
      if (gone && pid !== null) await clearOwnerRecord(ownerPath);
    };
    // Raw output exists in exactly one place and for exactly one purpose:
    // this bounded buffer, until the pairing URL is parsed out of it. Every
    // line leaves this closure redacted.
    const captured = { raw: "", pairingUrl: null as string | null };
    const logBuffers = new Map<string, ReturnType<typeof createStreamLineBuffer>>();
    const logComplete = (line: string): void => {
      if (line.trim().length > 0) log(redactT3Output(line));
    };
    // The broker refuses an output subscription for a child that already
    // exited, and the allocate-then-bind race this loop exists for can kill
    // one in the window since the spawn. A refused subscription is a failed
    // attempt, not a failed start: the loop must get its remaining attempts
    // instead of the raw broker error reaching the user.
    const subscribed = await child
      .onOutput((output) => {
        if (captured.pairingUrl === null) {
          captured.raw = (captured.raw + output.text).slice(-RAW_BUFFER_LIMIT);
          captured.pairingUrl = findPairingUrl(captured.raw);
          if (captured.pairingUrl !== null) captured.raw = "";
        }
        let buffer = logBuffers.get(output.stream);
        if (!buffer) {
          buffer = createStreamLineBuffer(logComplete);
          logBuffers.set(output.stream, buffer);
        }
        buffer.push(output.text);
      })
      .then(
        () => true,
        () => false,
      );
    if (!subscribed) {
      // A refusal for any other reason leaves a server this plugin can no
      // longer read; ending it keeps the workspace's t3 refs free for the
      // next attempt. Terminating an exited child is a no-op.
      await endFailedAttempt();
      return null;
    }
    const exited = child.wait({ timeoutMs: CHILD_WAIT_TIMEOUT_MS });
    const flushLogs = (): void => {
      for (const buffer of logBuffers.values()) buffer.flush();
    };
    void exited.then(flushLogs, flushLogs);

    try {
      await pollT3Readiness({
        environmentUrl: `http://127.0.0.1:${port}/.well-known/t3/environment`,
        childExited: exited,
        ...options.readiness,
      });
    } catch (error) {
      if (error instanceof T3ChildExitError) {
        await endFailedAttempt(true);
        return null;
      }
      // Version mismatch or readiness deadline: the process is not a server
      // this plugin may keep. Destroy it and report.
      await endFailedAttempt();
      throw error;
    }

    if (captured.pairingUrl === null) {
      await endFailedAttempt();
      throw new Error(
        "The t3 server became ready without printing its pairing URL. " +
          "Disable and re-enable the t3-code plugin to retry.",
      );
    }
    const server: ReadyServer = {
      origin: `http://127.0.0.1:${port}`,
      pairingUrl: captured.pairingUrl,
      child,
      ownerPath,
      alive: true,
      paired: false,
    };
    void exited.then(
      () => markExited(server),
      () => markExited(server),
    );
    return server;
  }

  /**
   * Ends the current server and disarms its ownership record. The record
   * exists to authorize a signal against a leftover process; once this server
   * is gone the record must go with it, or a routine exit arms the next start
   * against a pid the operating system is free to hand to someone else.
   */
  async function shutdownServer(): Promise<void> {
    const current = serverPromise;
    serverPromise = null;
    if (!current) return;
    const server = await current.catch(() => null);
    if (!server) return;
    const gone = server.alive
      ? await server.child.terminate().then(
          () => true,
          () => false,
        )
      : true;
    if (gone) await clearOwnerRecord(server.ownerPath);
  }

  function markExited(server: ReadyServer): void {
    server.alive = false;
    log("The t3 server process exited.");
  }

  async function startServer(): Promise<ReadyServer> {
    const entry = await resolveT3Entry(ctx.pluginRoot);
    const baseDir = join(ctx.stateRoot, "t3");
    await mkdir(baseDir, { recursive: true });
    const ownerPath = join(ctx.stateRoot, T3_OWNER_FILE_NAME);
    const recovery = await recoverStaleState({ baseDir, ownerPath });
    if (recovery.action !== "none") {
      log(`Stale server state handled before start: ${recovery.action}.`);
    }

    for (let attempt = 1; attempt <= SPAWN_ATTEMPT_LIMIT; attempt += 1) {
      const port = await allocateLoopbackPort();
      const server = await spawnAttempt(entry, baseDir, ownerPath, port);
      if (server) return server;
      log(`The t3 server exited before becoming ready (attempt ${attempt} of ${SPAWN_ATTEMPT_LIMIT}).`);
    }
    throw new Error(
      `The t3 server exited before becoming ready in ${SPAWN_ATTEMPT_LIMIT} attempts. ` +
        `Last output: ${recentLines.slice(-5).join(" | ") || "(none)"}`,
    );
  }

  function ensureServer(): Promise<ReadyServer> {
    if (disposed) {
      return Promise.reject(new Error("The t3-code plugin is deactivated."));
    }
    if (!serverPromise) {
      const attempt = startServer();
      serverPromise = attempt;
      attempt.catch(() => {
        if (serverPromise === attempt) serverPromise = null;
      });
    }
    return serverPromise;
  }

  async function ensureLiveServer(): Promise<ReadyServer> {
    const current = await ensureServer();
    if (current.alive) return current;
    if (serverPromise !== null) {
      const settled = await serverPromise;
      if (settled === current) serverPromise = null;
    }
    const restarted = await ensureServer();
    if (!restarted.alive) {
      throw new Error(
        "The t3 server exited right after starting. Check the plugin log.",
      );
    }
    return restarted;
  }

  return {
    async startWebApp(webAppId: string): Promise<PluginWebAppStart> {
      if (webAppId !== T3_WEB_APP_ID) {
        throw new Error(
          `The t3-code plugin has no web app "${webAppId}". It provides "${T3_WEB_APP_ID}".`,
        );
      }
      const server = await ensureLiveServer();
      // The pairing URL's fragment is a one-time credential: hand it to the
      // guest exactly once, then reopen against the paired session cookie.
      if (!server.paired) {
        server.paired = true;
        return { url: server.pairingUrl };
      }
      return { url: `${server.origin}/` };
    },

    // The guest this server paired with never arrived, and its credential is
    // spent. t3 pairs a browser session, not a request, and only a new server
    // mints a new credential — so end this one. The next start spawns and
    // pairs again.
    async stopWebApp(webAppId: string): Promise<void> {
      if (webAppId !== T3_WEB_APP_ID) {
        throw new Error(
          `The t3-code plugin has no web app "${webAppId}". It provides "${T3_WEB_APP_ID}".`,
        );
      }
      await shutdownServer();
    },

    async dispose(): Promise<void> {
      disposed = true;
      await shutdownServer();
    },
  };
}
