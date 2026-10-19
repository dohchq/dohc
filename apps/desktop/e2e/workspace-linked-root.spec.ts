import { expect, test } from "@playwright/test";
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { writeWorkspaceFile } from "../../../packages/mcp/src/tools";
import { canonicalWorkspaceRoot } from "../src/workspaces/createWorkspaceFolder";
import { launchDesktopApp } from "./helpers/desktopApp";
import { runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, waitForWorkspaceFile } from "./helpers/workspace";

test("a workspace opened through a link takes agent writes in its real folder", async () => {
  const temp = await createTempWorkspace();
  // The person opens the folder through a link, as with a folder moved to
  // another disk and linked back.
  const linked = { ...temp, rootPath: join(temp.baseDir, "linked") };
  await symlink(temp.rootPath, linked.rootPath, process.platform === "win32" ? "junction" : "dir");
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: linked });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, linked);
    expect(workspace.rootPath).toBe(canonicalWorkspaceRoot(temp.rootPath));
    await waitForCliEndpoint(temp.homeDir);

    // An MCP agent scoped to the linked folder.
    expect(await writeWorkspaceFile({ root: linked.rootPath, home: temp.homeDir }, { path: "agent.txt", content: "from MCP" }, "Linked agent"))
      .toMatchObject({ ok: true, path: "agent.txt" });
    // The dohc CLI run from the linked folder.
    await runDohcCli(linked, ["document", "create", "notes.md", "--text", "From the CLI.", "--agent", "Linked agent"]);

    expect(await readFile(join(temp.rootPath, "agent.txt"), "utf8")).toBe("from MCP");
    expect(await readFile(join(temp.rootPath, "notes.md"), "utf8")).toContain("From the CLI.");
    await waitForWorkspaceFile(page, workspace.workspaceId, "agent.txt");
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes.md");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
