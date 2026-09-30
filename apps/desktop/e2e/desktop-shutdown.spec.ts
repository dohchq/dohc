import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace } from "./helpers/workspace";

test("the real desktop launcher preserves a nonzero Electron exit", async () => {
  test.setTimeout(120_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace });
    const child = desktop.app.process();
    await desktop.app.evaluate(({ app }) => app.exit(1)).catch((error: unknown) => {
      // Exiting main can close its debugger before the evaluation replies.
      if (!(error instanceof Error) || !/Target.*closed|Execution context was destroyed/iu.test(error.message)) throw error;
    });
    await expect.poll(() => ({ exitCode: child.exitCode, signalCode: child.signalCode }), {
      message: "The launcher must forward Electron main's exit status.",
    }).toEqual({ exitCode: 1, signalCode: null });
    await expect(desktop.close()).rejects.toThrow("Electron exited with status 1.");
    desktop = null;
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
