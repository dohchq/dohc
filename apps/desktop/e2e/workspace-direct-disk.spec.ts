import { test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  createTempWorkspace,
  expectVisibleContent,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test("opens a temp workspace and shows direct disk file creation in the explorer", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);

    await writeWorkspaceFiles(temp, [
      {
        path: "notes/outside-agent.md",
        contents: "# Outside agent\n\nCreated directly on disk.\n",
      },
    ]);

    await waitForWorkspaceFile(
      desktop.page,
      workspace.workspaceId,
      "notes/outside-agent.md",
    );
    await revealExplorerPath(desktop.page, "notes/outside-agent.md");
    await expectVisibleContent(desktop.page, "outside-agent.md");
  } finally {
    await desktop?.close();
    await temp.cleanup();
  }
});
