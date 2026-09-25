import { rm, writeFile } from "node:fs/promises";

/**
 * The file View report opens in a text editor. It lives only while main's
 * dialog asks: it is removed when the dialog ends, when the report is
 * dismissed, and at startup, so the text never outlives the report.
 * It sits in dohc's user data folder, which only this user can read on
 * Windows, and it is created new with owner-only permissions elsewhere.
 */
export function createCrashReportPreview(deps: {
  path: string;
  // Opens the file in the system's editor. Resolves to an error message, or "".
  openPath(path: string): Promise<string>;
}) {
  async function remove(): Promise<void> {
    await rm(deps.path, { force: true }).catch((error: unknown) => {
      console.error("[crash-report] could not remove the report preview", error);
    });
  }
  return {
    remove,
    async show(text: string): Promise<void> {
      // Created new, so an older file's permissions are not kept.
      await rm(deps.path, { force: true });
      await writeFile(deps.path, text, { mode: 0o600, flag: "wx" });
      const failure = await deps.openPath(deps.path);
      if (failure) throw new Error(`dohc could not open the report: ${failure}`);
    },
  };
}
