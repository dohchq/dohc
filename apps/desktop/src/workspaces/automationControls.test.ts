import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createAutomationControls } from "./automationControls";

const source = "version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Ready\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(writable = true) {
  let text = source;
  let accepted: string | null = null;
  const write = vi.fn(async (_path: string, next: string, base: string) => {
    if (base !== hash(text)) return { status: "conflict" as const };
    text = next;
    return { status: "written" as const, sync: "pending" as const };
  });
  const controls = createAutomationControls({ resolve: async () => ({ content: { text, contentHash: hash(text), truncated: false },
    canSwitch: writable, delivery: { contentHash: hash(text), state: accepted === hash(text) ? "accepted" : "pending" } }), write,
  });
  return { controls, write, accept: () => { accepted = hash(text); }, input: { automation: "stamp", enabled: false, expectedContentHash: hash(source), reformat: true, submitId: "switch-1" } };
}
it("keeps offline saves pending until acceptance and never claims host application", async () => {
  const f = fixture();
  await expect(f.controls.switch("Tasks", f.input)).resolves.toMatchObject({ status: "written", sync: "pending" });
  await expect(f.controls.list("Tasks")).resolves.toMatchObject({ sync: "pending" });
  expect(await f.controls.list("Tasks")).not.toHaveProperty("history");
  f.accept();
  await expect(f.controls.list("Tasks")).resolves.toMatchObject({ sync: "accepted" });
});
it("refuses a concurrent toggle from a stale base", async () => {
  const f = fixture();
  await f.controls.switch("Tasks", f.input);
  await expect(f.controls.switch("Tasks", { ...f.input, enabled: true, submitId: "switch-2" })).resolves.toEqual({ status: "conflict" });
  expect(f.write).toHaveBeenCalledTimes(1);
});
it("keeps View, Comment and version controls read-only", async () => {
  const f = fixture(false);
  await expect(f.controls.list("Tasks")).resolves.toMatchObject({ canSwitch: false });
  await expect(f.controls.switch("Tasks", f.input)).resolves.toMatchObject({ status: "unavailable" });
  expect(f.write).not.toHaveBeenCalled();
});
it("keeps an indeterminate save unknown and fences acceptance against concurrent content", async () => {
  const controls = createAutomationControls({
    resolve: async () => ({ content: { text: source, contentHash: hash(source), truncated: false },
      canSwitch: true, delivery: { contentHash: hash("newer save"), state: "accepted" } }),
    write: async (_path, _text, _base, submitId) => ({ status: "unknown", submitId }),
  });
  const input = { automation: "stamp", enabled: false, expectedContentHash: hash(source), reformat: true, submitId: "unknown-1" };
  await expect(controls.switch("Tasks", input)).resolves.toEqual({ status: "unknown", submitId: input.submitId });
  await expect(controls.list("Tasks")).resolves.toMatchObject({ sync: "pending" });
});
it("does not mark a missing definition as a pending save", async () => {
  const controls = createAutomationControls({ resolve: async () => ({ content: null, canSwitch: true,
    delivery: { contentHash: null, state: "accepted" } }), write: async () => ({ status: "conflict" }) });
  await expect(controls.list("Tasks")).resolves.toMatchObject({ file: { status: "missing" }, sync: "accepted" });
});
it("rereads a landed unknown save and preserves the stale-base refusal on retry", async () => {
  let text = source;
  const write = vi.fn(async (_path: string, next: string, _base: string, submitId: string) => {
    text = next;
    return { status: "unknown" as const, submitId };
  });
  const controls = createAutomationControls({ resolve: async () => ({ content: { text, contentHash: hash(text), truncated: false },
    canSwitch: true, delivery: { contentHash: hash(text), state: "pending" } }), write });
  const input = { automation: "stamp", enabled: false, expectedContentHash: hash(source), reformat: true, submitId: "lost-1" };
  await expect(controls.switch("Tasks", input)).resolves.toEqual({ status: "unknown", submitId: input.submitId });
  const listed = await controls.list("Tasks");
  expect(listed.sync).toBe("pending");
  expect(listed.file.status === "read" && listed.file.entries[0]?.enabledInFile).toBe(false);
  await expect(controls.switch("Tasks", input)).resolves.toEqual({ status: "conflict" });
  expect(write).toHaveBeenCalledTimes(1);
});
