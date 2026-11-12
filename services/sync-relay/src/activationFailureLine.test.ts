import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import { expect, it } from "vitest";
import { activationFailureLine } from "./activationFailureLine";

const refusal = (code: string, message: string, method?: string) =>
  new EngineRequestError(1, { code, message, retry: "no" } as never, method);

it.each([
  ["a code word alone", "INVALID_PARAMS", "malformed-update", "malformed-update (code INVALID_PARAMS, method live.apply)"],
  ["a code word before a path", "CONFLICT", "sync-path-occupied: notes/secret plan.md",
    "sync-path-occupied (code CONFLICT, method live.apply)"],
  ["a code word before a sentence naming a file", "CONFLICT", "hosted-file-unexpected: notes/secret plan.md holds bytes the replica did not write",
    "hosted-file-unexpected (code CONFLICT, method live.apply)"],
  ["a sentence", "WORKSPACE_UNAVAILABLE", "workspace handle is unavailable",
    "unrecognized-message (code WORKSPACE_UNAVAILABLE, method live.apply)"],
  ["a path before the first separator", "CONFLICT", "notes/secret-plan.md: occupied",
    "unrecognized-message (code CONFLICT, method live.apply)"],
])("an engine refusal with %s logs only its code word", (_, code, message, line) => {
  const logged = activationFailureLine(refusal(code, message, "live.apply"));
  expect(logged).toBe(line);
  expect(logged).not.toContain("secret");
});

it("a refusal without a method logs its code alone", () => {
  expect(activationFailureLine(refusal("INVALID_PARAMS", "malformed-update"))).toBe("malformed-update (code INVALID_PARAMS)");
});

it("the relay's own failures keep their message", () => {
  expect(activationFailureLine(new Error("Departing live document is waiting: settlement-pending")))
    .toBe("Departing live document is waiting: settlement-pending");
});
