import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { killChildTreeWin32, resolveSpawnCommand } from "../process/windowsSpawn";
import { T3CodeError, type T3CodeAccess } from "./t3Code";

// T3 Code's own command-line program, which the desktop app writes into its
// folder. dohc runs it for one thing: to make the sign-in code that approves
// dohc's own sign-in, after the person said yes in dohc. The code is typed
// nowhere and kept nowhere by dohc. T3 Code keeps it until it is used.

/** What T3 Code wants a code to carry before it approves a sign-in with each access. */
export const T3_CODE_ACCESS_SCOPES: Record<T3CodeAccess, readonly string[]> = {
  "approval-required": ["orchestration:read", "orchestration:operate"],
  "auto-accept-edits": ["orchestration:read", "orchestration:operate"],
  auto: ["orchestration:read", "orchestration:operate"],
  "full-access": [
    "orchestration:read",
    "orchestration:operate",
    "settings:write",
    "source-control:write",
  ],
};

/** How long the code lasts. dohc uses it at once. */
const CODE_LIFE = "1m";
/** How long T3 Code's program may take before dohc ends it. */
const RUN_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const Made = z.object({ credential: z.string().regex(/^[\x21-\x7e]{6,128}$/u) });

/** Runs a program and gives what it printed. It never logs what it reads. */
export type T3CodeCliRunner = (
  command: string,
  args: string[],
  signal: AbortSignal,
) => Promise<{ exitCode: number | null; stdout: string }>;

/** Where T3 Code's desktop app writes its program, in T3 Code's own folder. */
export function t3CodeCliPath(home: string, platform: NodeJS.Platform = process.platform): string {
  return join(home, "bin", platform === "win32" ? "t3.cmd" : "t3");
}

const runProgram: T3CodeCliRunner = (command, args, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    // On Windows the program is a .cmd file, which runs behind cmd.exe. The
    // helper quotes every part and refuses one it cannot quote safely.
    const resolved = resolveSpawnCommand(command, args);
    const child = spawn(resolved.command, resolved.args, {
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      // Nothing is sent to it, and what it says of a failure is not read: it may hold a secret.
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let over = false;
    const end = () => {
      // The .cmd file starts the real program, so the whole tree is ended.
      void killChildTreeWin32(child).then((killed) => {
        if (!killed) child.kill();
      });
    };
    const timer = setTimeout(end, RUN_TIMEOUT_MS);
    signal.addEventListener("abort", end, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (over) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        over = true;
        stdout = "";
        end();
      }
    });
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", end);
      if (signal.aborted) reject(signal.reason as Error);
      else resolve({ exitCode: over ? null : exitCode, stdout });
    };
    child.once("error", () => done(null));
    child.once("close", (exitCode) => done(exitCode));
  });

const UNAVAILABLE = "dohc could not make its own sign-in code in T3 Code.";

/**
 * Makes one sign-in code with T3 Code's own program, good for a minute and
 * for no more than `access` needs. Rejects with "cannot-allow-here" when the
 * program is not there, does not answer, or refuses, as when a policy on
 * this computer forbids such codes.
 */
export function createT3CodeCodeMaker(options: {
  /** T3 Code's own folder, `.t3` in the person's home. */
  home: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  run?: T3CodeCliRunner;
}): {
  /** Whether T3 Code's program is where its desktop app writes it. */
  available(): boolean;
  make(access: T3CodeAccess, signal: AbortSignal): Promise<string>;
} {
  const program = t3CodeCliPath(options.home, options.platform);
  const exists = options.exists ?? existsSync;
  const run = options.run ?? runProgram;
  return {
    available: () => exists(program),
    async make(access, signal) {
      if (!exists(program)) throw new T3CodeError("cannot-allow-here", UNAVAILABLE);
      const args = ["auth", "pairing", "create"];
      for (const scope of T3_CODE_ACCESS_SCOPES[access]) args.push("--scope", scope);
      args.push("--ttl", CODE_LIFE, "--label", "dohc", "--json");
      let ran: Awaited<ReturnType<T3CodeCliRunner>>;
      try {
        ran = await run(program, args, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason as Error;
        // A path this computer's shell cannot carry safely, or a program that would not start.
        void error;
        throw new T3CodeError("cannot-allow-here", UNAVAILABLE);
      }
      if (ran.exitCode !== 0) throw new T3CodeError("cannot-allow-here", UNAVAILABLE);
      let made: z.infer<typeof Made>;
      try {
        made = Made.parse(JSON.parse(ran.stdout));
      } catch {
        throw new T3CodeError("cannot-allow-here", UNAVAILABLE);
      }
      return made.credential;
    },
  };
}
