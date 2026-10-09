import { expect, it } from "vitest";
import { mainProcessCrashText } from "../../e2e/helpers/mainProcessCrashText";

const main = (text: string) => ({source: "main", level: "error", text});

it.each(["'transport-error'", "\u001b[32m'transport-error'\u001b[39m"])("does not count a caught daemon transport failure as a main-process crash (%s)", (code) => {
  const caught = main(`[desktop] workspace engine capture ydoc settle of abuse/kill.md failed for workspace: Error [EngineClientError]: The engine client is closed: Engine transport failed.\n code: ${code},\n cause: Error: write EPIPE`);
  expect(mainProcessCrashText([caught])).toEqual([]);
});

it("still detects bare EPIPE and both uncaught exception reports", () => {
  const fatal = [main("Error: write EPIPE"), main("Uncaught Exception: Error: write EPIPE"), main("A JavaScript error occurred in the main process")];
  expect(mainProcessCrashText(fatal)).toEqual(fatal.map(log => log.text));
});

it("ignores renderer errors and ordinary main-process messages", () => {
  expect(mainProcessCrashText([{source: "renderer", level: "error", text: "EPIPE"}, main("Workspace opened")])).toEqual([]);
});
