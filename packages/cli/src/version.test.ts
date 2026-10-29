import { expect, it, vi } from "vitest";
import { executeCli } from "./index";
import { parseCliArguments } from "./args";

it("parses each version verb and refuses a missing or extra operand before transport", async () => {
  expect(parseCliArguments(["version", "list"], {})).toMatchObject({ verb: "versionList" });
  expect(parseCliArguments(["version", "compare", "Draft", "--after", "a.md"], {})).toMatchObject({ verb: "versionCompare", version: "Draft", afterPath: "a.md" });
  expect(parseCliArguments(["version", "conflicts", "--after", "c1"], {})).toMatchObject({ verb: "versionConflicts", afterConflictId: "c1" });
  const request = vi.fn();
  for (const argv of [["version", "compare"], ["version", "compare", "Draft", "Later"], ["version", "list", "extra"]]) {
    expect((await executeCli({ argv, request })).exitCode).toBe(1);
  }
  expect(request).not.toHaveBeenCalled();
});

it("marks binary files and conflicts, and exits 1 with a refusal's reason", async () => {
  const request = vi.fn(async () => ({ ok: true, version: { id: "draft", name: "Draft" },
    files: [{ path: "logo.png", status: "added", binary: true }], nextAfterPath: null }));
  expect(await executeCli({ argv: ["version", "compare", "Draft"], request })).toEqual({ exitCode: 0, stdout: "added · logo.png · binary\n", stderr: "" });
  request.mockResolvedValueOnce({ ok: true, nextAfterConflictId: "c1", conflicts: [{ conflictId: "c1", path: "logo.png", sourceVersionId: "draft",
    targetVersionId: "main", origin: "sync", contentKind: "binary", currentText: null, incomingText: null, baseText: null }] } as never);
  expect((await executeCli({ argv: ["version", "conflicts"], request })).stdout).toBe("c1 · sync · logo.png · binary\nMore conflicts; use --after c1\n");
  request.mockResolvedValueOnce({ ok: false, reason: "Versions belong to the owning workspace. Open it to continue." } as never);
  expect(await executeCli({ argv: ["version", "list"], request })).toEqual({ exitCode: 1, stdout: "",
    stderr: "dohc: Versions belong to the owning workspace. Open it to continue.\n" });
});

it("parses the version changes and refuses a bad name or resolution before transport", async () => {
  expect(parseCliArguments(["version", "create", " Ideas "], {})).toMatchObject({ verb: "versionCreate", name: "Ideas" });
  expect(parseCliArguments(["version", "switch", "Draft"], {})).toMatchObject({ verb: "versionSwitch", version: "Draft" });
  expect(parseCliArguments(["version", "merge", "Draft"], {})).toMatchObject({ verb: "versionMerge", version: "Draft" });
  const request = vi.fn(async (_sent: unknown) => ({ ok: true, conflicts: [], nextAfterConflictId: null }));
  await executeCli({ argv: ["version", "resolve", "c1", "--keep", "incoming"], request });
  await executeCli({ argv: ["version", "resolve", "c1", "--text", "both"], request });
  await executeCli({ argv: ["version", "resolve", "c1", "-"], request, readStdin: async () => "from stdin" });
  expect(request.mock.calls.map(([sent]) => (sent as { args: { resolution: unknown } }).args.resolution)).toEqual([
    { keep: "incoming" }, { keep: "combined", text: "both" }, { keep: "combined", text: "from stdin" }]);
  request.mockClear();
  for (const argv of [["version", "create", "x".repeat(81)], ["version", "create", " "], ["version", "switch"],
    ["version", "resolve", "c1"], ["version", "resolve", "c1", "--keep", "current", "--text", "both"], ["version", "resolve", "c1", "--keep", "combined"]]) {
    expect((await executeCli({ argv, request })).exitCode, argv.join(" ")).toBe(1);
  }
  expect(request).not.toHaveBeenCalled();
});

it("says what a version change did", async () => {
  const request = vi.fn(async (_sent: unknown) => ({ ok: true, version: { id: "draft", name: "Draft" }, changedFileCount: 1 }));
  expect((await executeCli({ argv: ["version", "switch", "Draft"], request })).stdout).toBe("Switched to Draft · 1 file changed\n");
  request.mockResolvedValueOnce({ ok: true, version: { id: "ideas", name: "Ideas" } } as never);
  expect((await executeCli({ argv: ["version", "create", "Ideas"], request })).stdout).toBe("Created and switched to Ideas · ideas\n");
  request.mockResolvedValueOnce({ ok: true, version: { id: "draft", name: "Draft" }, mergedFileCount: 2, unchangedFileCount: 0, conflictCount: 1,
    nextAfterConflictId: null, conflicts: [{ conflictId: "c1", path: "notes.md", sourceVersionId: "draft", targetVersionId: "main", origin: "merge",
      contentKind: "text", currentText: "a", incomingText: "b", baseText: null }] } as never);
  expect((await executeCli({ argv: ["version", "merge", "Draft"], request })).stdout)
    .toBe("Merged Draft into Main · 2 files merged · 1 conflict\nc1 · merge · notes.md\n");
});
