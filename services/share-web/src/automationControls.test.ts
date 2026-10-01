import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createSharedAutomationControls } from "./automationControls";
import { serializeAutomationSwitch } from "@dohc/workspace-contracts/automation-controls";
import { MAX_AUTOMATIONS_FILE_BYTES } from "@dohc/workspace-contracts/automations";

const source = "version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Ready\n        operation: records.edit\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const input = { automation: "stamp", enabled: false, expectedContentHash: hash(source), reformat: true, submitId: "switch-1" };
function fixture(access: "view" | "comment" | "edit" = "edit", paths = ["Tasks"], versionId: string | null = null, content = source, automationSwitchable = true) {
  const calls: string[] = [], writes: unknown[] = [];
  let outcome = "accepted", unknown = false;
  const controls = createSharedAutomationControls({
    metadata: { access, effectiveSelector: { paths, versionId } }, signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000,
    request: async (path, init) => {
      calls.push(path);
      if (path === "/api/view/current?collectionPath=Tasks") return Response.json({ ok: true, files: paths.some(path => path === "Tasks" || path === "Tasks/automations.yaml")
        ? [{ path: "Tasks/automations.yaml", blobSha256: hash(content), contentKind: "text", automationSwitchable }] : [{ path: "Tasks/one.md", blobSha256: hash("record"), contentKind: "text" }] });
      if (path.startsWith("/api/view/blob/")) return new Response(content);
      if (path === "/api/view/collection-writes") {
        writes.push(JSON.parse(String(init?.body)));
        if (unknown) throw new Error("lost reply");
        return outcome === "accepted" ? Response.json({ ok: true, outcome, submitId: input.submitId })
          : Response.json({ ok: false, outcome, path: "Tasks/automations.yaml", currentBlobSha256: hash("newer") }, { status: 409 });
      }
      throw new Error(path);
    },
  });
  return { controls, calls, writes, loseReply: () => { unknown = true; }, stale: () => { outcome = "stale"; } };
}
it.each(["view", "comment", "edit"] as const)("lists shared definitions for %s and permits only Edit switches", async access => {
  const f = fixture(access);
  await expect(f.controls.list("Tasks")).resolves.toMatchObject({ canSwitch: access === "edit", contentHash: hash(source), file: { status: "read" } });
  expect(await f.controls.list("Tasks")).not.toHaveProperty("history");
  await expect(f.controls.switch("Tasks", input)).resolves.toMatchObject({ status: access === "edit" ? "written" : "unavailable" });
});
it("does not offer a switch refused by the server's dataset catalog", async () => {
  const f = fixture("edit", ["Tasks"], null, source, false);
  await expect(f.controls.list("Tasks")).resolves.toMatchObject({ canSwitch: false, switchReason: expect.stringContaining("server does not accept") });
  await expect(f.controls.switch("Tasks", input)).resolves.toMatchObject({ status: "unavailable" });
  expect(f.writes).toEqual([]);
});
it("reads a version's saved definition read-only and never requests a file share's sibling", async () => {
  const version = fixture("edit", ["Tasks"], "saved");
  await expect(version.controls.list("Tasks")).resolves.toMatchObject({ canSwitch: false, file: { status: "read" } });
  await expect(version.controls.switch("Tasks", input)).resolves.toMatchObject({ status: "unavailable" });
  const file = fixture("edit", ["Tasks/one.md"]);
  await expect(file.controls.list("Tasks")).resolves.toMatchObject({ canSwitch: false, file: { status: "missing" } });
  expect(file.calls).toEqual(["/api/view/current?collectionPath=Tasks"]);
  await expect(fixture("edit", ["Tasks/automations.yaml"]).controls.list("Tasks")).resolves.toMatchObject({ canSwitch: false, file: { status: "read" } });
});
it("uses the common serializer and preserves bindings through the existing link write route", async () => {
  const f = fixture();
  const prepared = await serializeAutomationSwitch({ text: source, contentHash: hash(source), truncated: false }, input);
  if (prepared.status !== "prepared") throw new Error("fixture");
  await expect(f.controls.switch("Tasks", input)).resolves.toMatchObject({ status: "written", sync: "accepted", contentHash: hash(prepared.text) });
  expect(f.writes).toEqual([expect.objectContaining({ submitId: input.submitId, changes: [expect.objectContaining({ afterPath: "Tasks/automations.yaml",
    basedOnBlobSha256: hash(source), afterContentBase64: Buffer.from(prepared.text).toString("base64") })] })]);
});
it("returns unknown after lost replies and rebuilds the same request for retry", async () => {
  const f = fixture(); f.loseReply();
  await expect(f.controls.switch("Tasks", input)).resolves.toEqual({ status: "unknown", submitId: input.submitId });
  await f.controls.switch("Tasks", input);
  const requests = f.writes as Array<{ submitId: string; changes: Array<{ recordedAtMs: number }> }>;
  const payloads = requests.map(request => ({ ...request, changes: request.changes.map(({ recordedAtMs: _at, ...change }) => change) }));
  expect(payloads[0]).toEqual(payloads[1]);
  expect(requests[0]?.submitId).toBe(requests[1]?.submitId);
});
it("reports relay stale bases and refuses invalid YAML or absent formatting consent before writing", async () => {
  const f = fixture(); f.stale();
  await expect(f.controls.switch("Tasks", input)).resolves.toEqual({ status: "conflict" });
  const invalid = fixture("edit", ["Tasks"], null, "version: [");
  await expect(invalid.controls.switch("Tasks", { ...input, expectedContentHash: hash("version: [") })).resolves.toEqual({ status: "unreadable" });
  expect(invalid.writes).toEqual([]);
  const commented = `# Keep this comment\n${source}`;
  await expect(fixture("edit", ["Tasks"], null, commented).controls.switch("Tasks", { ...input, expectedContentHash: hash(commented), reformat: false })).resolves.toEqual({ status: "reformats" });
});
it("exposes personal steps read-only and refuses them before the link write", async () => {
  const personal = `${source}      - wake-agent: Check\n        person: user_ana\n`;
  const f = fixture("edit", ["Tasks"], null, personal);
  const listed = await f.controls.list("Tasks");
  expect(listed.file.status === "read" && listed.file.entries[0]?.canSwitch).toBe(false);
  await expect(f.controls.switch("Tasks", { ...input, expectedContentHash: hash(personal) })).resolves.toMatchObject({ status: "unavailable" });
  expect(f.writes).toEqual([]);
});
it("keeps an oversized definition unreadable through the common bounded reader", async () => {
  const content = "x".repeat(MAX_AUTOMATIONS_FILE_BYTES + 1);
  const f = fixture("edit", ["Tasks"], null, content);
  await expect(f.controls.list("Tasks")).resolves.toMatchObject({ file: { status: "unreadable", diagnostic: { code: "file-too-large" } } });
  await expect(f.controls.switch("Tasks", { ...input, expectedContentHash: hash(content) })).resolves.toEqual({ status: "unreadable" });
  expect(f.writes).toEqual([]);
});
