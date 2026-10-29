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
