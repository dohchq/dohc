import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import { EngineClientError, EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import { expect, it } from "vitest";
import { RelayError } from "./errors";
import { childStderrLog, serverLogLine, ServerLogError } from "./serverLogWords";

const secret = "notes/secret plan.md";
const refusal = (code: string, message: string, method?: string) =>
  new EngineRequestError(1, { code, message, retry: "no" } as never, method);
const fsError = (code: string) =>
  Object.assign(new Error(`${code}: no such file or directory, open '/srv/dohc/${secret}'`), {
    code,
    errno: -2,
    syscall: "open",
    path: `/srv/dohc/${secret}`,
  });

it.each([
  [
    "a code word alone",
    "INVALID_PARAMS",
    "malformed-update",
    "malformed-update (code INVALID_PARAMS, method live.apply)",
  ],
  [
    "a code word before a path",
    "CONFLICT",
    `sync-path-occupied: ${secret}`,
    "sync-path-occupied (code CONFLICT, method live.apply)",
  ],
  [
    "a code word before a sentence naming a file",
    "CONFLICT",
    `hosted-file-unexpected: ${secret} holds bytes the replica did not write`,
    "hosted-file-unexpected (code CONFLICT, method live.apply)",
  ],
  [
    "a sentence",
    "WORKSPACE_UNAVAILABLE",
    "workspace handle is unavailable",
    "unrecognized-message (code WORKSPACE_UNAVAILABLE, method live.apply)",
  ],
  [
    "a path before the first separator",
    "CONFLICT",
    "notes/secret-plan.md: occupied",
    "unrecognized-message (code CONFLICT, method live.apply)",
  ],
  [
    "a wire code that is not one",
    "notes/secret plan",
    "malformed-update",
    "malformed-update (code unrecognized, method live.apply)",
  ],
])(
  "an engine refusal with %s logs only its code word, wire code and method",
  (_, code, message, words) => {
    const logged = serverLogLine(refusal(code, message, "live.apply"));
    expect(logged).toBe(`EngineRequestError: ${words}`);
    expect(logged).not.toContain("secret");
  },
);

it("an engine refusal without a method logs its code word and wire code", () => {
  expect(serverLogLine(refusal("INVALID_PARAMS", "malformed-update"))).toBe(
    "EngineRequestError: malformed-update (code INVALID_PARAMS)",
  );
});

it("an adapter's refusal logs its code word and the method of the request it wraps", () => {
  const cause = refusal("CONFLICT", `capture-file-held: ${secret}`, "ydoc.apply");
  expect(
    serverLogLine(
      new DaemonRefusalError({ code: "CONFLICT", message: cause.message, retry: "no" }, cause),
    ),
  ).toBe("DaemonRefusalError: capture-file-held (code CONFLICT, method ydoc.apply)");
});

it.each([
  ["a file system error", fsError("ENOENT"), "Error: ENOENT"],
  [
    "an error with a code it does not know",
    Object.assign(new Error(secret), { code: secret }),
    "Error",
  ],
  ["an error whose name names a file", Object.assign(new Error(secret), { name: secret }), "Error"],
  ["a known class", new TypeError(`Cannot read ${secret}`), "TypeError"],
  [
    "a SQLite error",
    Object.assign(new Error(secret), { code: "ERR_SQLITE_ERROR", errcode: 11 }),
    "Error: ERR_SQLITE_ERROR (errcode 11)",
  ],
  [
    "an engine client failure",
    new EngineClientError("transport-error", `Engine connection reset at ${secret}.`),
    "EngineClientError: transport-error",
  ],
  [
    "a relay refusal",
    new RelayError("host-moved", undefined, undefined, undefined, secret),
    "RelayError: host-moved",
  ],
  [
    "an error with a cause",
    new Error("Could not open the store.", { cause: fsError("EACCES") }),
    "Error",
  ],
  ["a thrown string", secret, "thrown string"],
])("%s logs its class and a known code only", (_, error, line) => {
  expect(serverLogLine(error)).toBe(line);
});

it("a relay failure built from fixed words logs whole", () => {
  expect(
    serverLogLine(new ServerLogError("Hosted publication is waiting for owner admission.")),
  ).toBe("ServerLogError: Hosted publication is waiting for owner admission.");
});

it("child stderr forwards only the engine's internal refusal lines and counts the rest", () => {
  const lines: string[] = [];
  const forward = childStderrLog("[service-live-host]", (line) => lines.push(line));
  forward(
    `engine: live document ${secret} history needs attention\nengine: internal refusal: INTERNAL relay-`,
  );
  forward("failed\r\nengine: internal refusal: INTERNAL notes/secret plan.md\n\n");
  forward(`${"x".repeat(5000)}`);
  forward(`${secret}\nengine: internal refusal: CONFLICT capture-not-owned\n`);
  expect(lines).toEqual([
    "[service-live-host] withheld 1 stderr line that can name files.",
    "[service-live-host] engine: internal refusal: INTERNAL relay-failed",
    "[service-live-host] withheld 1 stderr line that can name files.",
    "[service-live-host] withheld 1 stderr line that can name files.",
    "[service-live-host] engine: internal refusal: CONFLICT capture-not-owned",
  ]);
  expect(lines.join("\n")).not.toContain("secret");
});

it("child stderr reporting that fails does not throw", () => {
  const forward = childStderrLog("[automation-replicas]", () => {
    throw new Error("closed");
  });
  expect(() => forward(`${secret}\n`)).not.toThrow();
});
