import { expect, it } from "vitest";
import { mainProcessCrashText, mainProcessLogLines } from "../../e2e/helpers/mainProcessCrashText";

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

it("a caught settle line cannot excuse a fatal EPIPE in the same output chunk", () => {
 const caught = "[desktop] workspace engine capture ydoc settle of note.md Error [EngineClientError]: code: 'transport-error' EPIPE";
 expect(mainProcessCrashText([main(caught + "\nError: write EPIPE\n")])).toEqual(["Error: write EPIPE"]);
});
it("a caught multiline settle cannot excuse a separate fatal line", () => {
 const caught = "[desktop] workspace engine capture ydoc settle of note.md Error [EngineClientError]:\n code: 'transport-error',\n cause: Error: write EPIPE\n}\n";
 expect(mainProcessCrashText([main(caught + "Error: write EPIPE\n")])).toEqual(["Error: write EPIPE"]);
});
it("reassembles split chunks before matching crash lines and preserves a final unterminated line", () => {
 const logs: ReturnType<typeof main>[] = [];
 const recorder = mainProcessLogLines(line => logs.push(main(line)));
 recorder.chunk("[desktop] workspace engine capture ydoc settle of note.md Error [EngineClientError]: code: 'transport-");
 recorder.chunk("error' EP");recorder.chunk("IPE\r\nError: write EP");recorder.chunk("IPE");
 expect(logs).toHaveLength(1);expect(mainProcessCrashText(logs)).toEqual([]);
 recorder.end();expect(mainProcessCrashText(logs)).toEqual(["Error: write EPIPE"]);
});

it("a caught block ends at its closing brace and cannot excuse a later indented EPIPE", () => {
 const caught = "[desktop] workspace engine capture ydoc settle of note.md Error [EngineClientError]:\n code: 'transport-error',\n cause: Error: write EPIPE\n}\n";
 expect(mainProcessCrashText([main(caught + "  Error: write EPIPE\n")])).toEqual(["  Error: write EPIPE"]);
});
it("a caught stderr log cannot excuse an EPIPE from stdout", () => {
 const head={source:"main",level:"stderr",text:"[desktop] workspace engine capture ydoc settle of note.md Error [EngineClientError]:"};
 const fatal={source:"main",level:"stdout",text:"  Error: write EPIPE"};
 expect(mainProcessCrashText([head,fatal,{source:"main",level:"stderr",text:" code: 'transport-error'"}])).toEqual([fatal.text]);
});
