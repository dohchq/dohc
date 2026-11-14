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
