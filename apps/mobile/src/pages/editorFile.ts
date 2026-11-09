import { Directory, File, Paths } from "expo-file-system";
import { pageFonts, pageHtml, pageScript, pageVersion } from "../editorHtml.generated";

// The page's web view loads its HTML from a file, and the HTML loads the ~690 KB script and the body's Inter files
// from their own files, so nothing large crosses the bridge per open and WebKit can cache the compiled script. The
// folder is named for a hash of every file, so a new build never reads an old copy.
const folder = new Directory(Paths.cache, `editor-${pageVersion}`);
const file = new File(folder, "page.html");
const script = new File(folder, "page.js");
const fonts = pageFonts.map(font => ({ file: new File(folder, font.name), base64: font.base64 }));

let pending: Promise<string> | null = null;

/** The file URI of the editor page. The files are checked on every call and written when missing: iOS can clear the
 * cache folder while the app runs, and Try again must then write them again. Callers at the same moment share one
 * check. */
export function editorHtmlUri(): Promise<string> {
  pending ??= (async () => {
    try {
      if (!folder.exists) folder.create({ intermediates: true });
      if (!script.exists) await script.write(pageScript);
      for (const font of fonts) if (!font.file.exists) await font.file.write(font.base64, { encoding: "base64" });
      if (!file.exists) await file.write(pageHtml);
      return file.uri;
    } catch (error) {
      // A write that failed (a full disk, say) may have left half a file: the folder goes, so the next try writes
      // every file again.
      try { if (folder.exists) folder.delete(); } catch { /* the next try finds what's left and writes it again */ }
      throw error;
    }
  })().finally(() => { pending = null; });
  return pending;
}

/** Design review only: the page's font files, for the demo that removes them before a page opens. */
export const editorFontFiles = fonts.map(font => font.file);

/** The folder the web view may read from. */
export const editorFolderUri = folder.uri;

/** Whether a failed write ran out of space: the system's own message for Cocoa's out-of-space error (640) or POSIX's
 * ENOSPC, which is all the file system passes on. */
export function isOutOfSpace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /isn[’']t enough space|not enough space|no space left on device/i.test(message);
}
