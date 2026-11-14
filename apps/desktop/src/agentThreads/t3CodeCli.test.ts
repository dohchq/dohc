import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { T3CodeError, T3_CODE_ACCESS } from "./t3Code";
import {
  createT3CodeCodeMaker,
  t3CodeCliPath,
  T3_CODE_ACCESS_SCOPES,
  type T3CodeCliRunner,
} from "./t3CodeCli";

const HOME = "/home/sam/.t3";
const PROGRAM = t3CodeCliPath(HOME, "linux");
const never = new AbortController().signal;

function maker(run: T3CodeCliRunner, there = true) {
  const ran: Array<{ command: string; args: string[] }> = [];
  const codes = createT3CodeCodeMaker({
    home: HOME,
    platform: "linux",
    exists: (path) => there && path === PROGRAM,
    run: async (command, args, signal) => {
      ran.push({ command, args });
      return run(command, args, signal);
    },
  });
  return { codes, ran };
}

const printed =
  (value: unknown): T3CodeCliRunner =>
  async () => ({
    exitCode: 0,
    stdout: JSON.stringify(value),
  });

describe("making dohc's own sign-in code with T3 Code's program", () => {
  it("names the program where T3 Code's desktop app writes it", () => {
    expect(t3CodeCliPath("C:\\Users\\sam\\.t3", "win32")).toMatch(/[\\/]bin[\\/]t3\.cmd$/u);
    expect(t3CodeCliPath(HOME, "darwin")).toMatch(/[\\/]bin[\\/]t3$/u);
  });

  it("asks for a code that lasts a minute and carries only what the access needs", async () => {
    const { codes, ran } = maker(printed({ id: "p1", credential: "Q8RZ3NWD5KTC", scopes: [] }));

    await expect(codes.make("auto", never)).resolves.toBe("Q8RZ3NWD5KTC");
    await codes.make("full-access", never);

    expect(ran.map((call) => call.command)).toEqual([PROGRAM, PROGRAM]);
    expect(ran[0]!.args).toEqual([
      "auth",
      "pairing",
      "create",
      "--scope",
      "orchestration:read",
      "--scope",
      "orchestration:operate",
      "--ttl",
      "1m",
      "--label",
      "dohc",
      "--json",
    ]);
    // Full access is the one mode T3 Code wants more for.
    expect(ran[1]!.args.filter((arg) => arg.includes(":"))).toEqual([
      "orchestration:read",
      "orchestration:operate",
      "settings:write",
      "source-control:write",
    ]);
    // Every mode a person can pick has its scopes, and none asks for more than full access does.
    for (const access of T3_CODE_ACCESS)
      for (const scope of T3_CODE_ACCESS_SCOPES[access])
        expect(T3_CODE_ACCESS_SCOPES["full-access"]).toContain(scope);
  });

  it("says it cannot allow dohc here when the program is missing, fails, or prints what dohc cannot read", async () => {
    const missing = maker(printed({ credential: "Q8RZ3NWD5KTC" }), false);
    expect(missing.codes.available()).toBe(false);
    await expect(missing.codes.make("auto", never)).rejects.toMatchObject({
      problem: "cannot-allow-here",
    });
    // A program that is not there is not run.
    expect(missing.ran).toEqual([]);

    const cases: T3CodeCliRunner[] = [
      // A policy on this computer forbids such codes: the program exits with a failure.
      async () => ({ exitCode: 1, stdout: "" }),
      // What a program that failed printed is not read as a code.
      async () => ({ exitCode: 1, stdout: JSON.stringify({ credential: "Q8RZ3NWD5KTC" }) }),
      // Ended for taking too long.
      async () => ({ exitCode: null, stdout: "" }),
      async () => ({ exitCode: 0, stdout: "not json" }),
      printed({ id: "p1" }),
      printed({ credential: "has a space" }),
      // A path this computer's shell cannot carry safely.
      async () => {
        throw new Error("Command argument contains a percent sign.");
      },
    ];
    for (const run of cases) {
      const { codes } = maker(run);
      expect(codes.available()).toBe(true);
      const error = await codes.make("auto", never).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(T3CodeError);
      expect(error).toMatchObject({
        problem: "cannot-allow-here",
        // The words never carry what the program printed.
        message: "dohc could not make its own sign-in code in T3 Code.",
      });
    }
  });

  it("stops with the caller's reason when the person cancels", async () => {
    const cancel = new AbortController();
    const reason = new T3CodeError("not-allowed", "The sign-in to T3 Code was cancelled.");
    const { codes } = maker(
      (_command, _args, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("killed")));
          cancel.abort(reason);
        }),
    );
    await expect(codes.make("auto", cancel.signal)).rejects.toBe(reason);
  });
});

// The same, with a program file this computer runs. The file stands in for
// T3 Code's own: it records what it was asked and prints the file beside it.
describe("running T3 Code's program", () => {
  const windows = process.platform === "win32";

  async function program(script: { windows: string; other: string }) {
    const home = await mkdtemp(join(tmpdir(), "dohc t3 program "));
    const bin = join(home, "bin");
    await mkdir(bin);
    const path = t3CodeCliPath(home);
    await writeFile(path, windows ? script.windows : script.other);
    if (!windows) await chmod(path, 0o755);
    return { home, bin, codes: createT3CodeCodeMaker({ home }) };
  }

  it("reads the code a program prints, and none from one that fails", async () => {
    const { home, bin, codes } = await program({
      windows: '@echo %*> "%~dp0asked.txt"\r\n@type "%~dp0made.json" 2>nul\r\n',
      other:
        '#!/bin/sh\necho "$*" > "$(dirname "$0")/asked.txt"\nexec cat "$(dirname "$0")/made.json" 2>/dev/null\n',
    });
    try {
      expect(codes.available()).toBe(true);
      await expect(codes.make("auto", never)).rejects.toMatchObject({
        problem: "cannot-allow-here",
      });
      await writeFile(join(bin, "made.json"), JSON.stringify({ credential: "Q8RZ3NWD5KTC" }));
      await expect(codes.make("full-access", never)).resolves.toBe("Q8RZ3NWD5KTC");
      // cmd.exe hands a .cmd file each part in the quotes it arrived in.
      const asked = (await readFile(join(bin, "asked.txt"), "utf8")).replaceAll('"', "").trim();
      expect(asked).toBe(
        "auth pairing create --scope orchestration:read --scope orchestration:operate " +
          "--scope settings:write --scope source-control:write --ttl 1m --label dohc --json",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("ends a program that is still running when the person cancels", async () => {
    const { home, codes } = await program({
      windows: "@ping -n 60 127.0.0.1 >nul\r\n",
      other: "#!/bin/sh\nexec sleep 60\n",
    });
    const cancel = new AbortController();
    const reason = new T3CodeError("not-allowed", "The sign-in to T3 Code was cancelled.");
    try {
      const making = codes.make("auto", cancel.signal);
      setTimeout(() => cancel.abort(reason), 300);
      await expect(making).rejects.toBe(reason);
    } finally {
      // The folder can be removed once the program no longer holds it.
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);
});
