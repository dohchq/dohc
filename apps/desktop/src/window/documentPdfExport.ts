import { BrowserWindow, type PrintToPDFOptions } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "Export as PDF" (ViewHeader document menu): the renderer already built a
// SELF-CONTAINED HTML document (documentExport.ts — inline styles, no
// external assets); this module's only job is turning that string into PDF
// bytes. It never touches workspace files or IPC identity — the caller
// (main.ts's exportDocumentFile handler) already validated the payload and
// picked the save path.
//
// marginType "none": the exported HTML supplies its own page padding
// (documentExport.ts's EXPORT_STYLE_CSS), so Chromium's own default print
// margins would double up the whitespace — this keeps the PDF's layout
// identical to the HTML export opened in a browser.
const PDF_PRINT_OPTIONS: PrintToPDFOptions = {
  pageSize: "A4",
  printBackground: true,
  margins: { marginType: "none" },
};

let exportInFlight = false;

// Exposed for the IPC handler to give an honest "try again" error instead of
// silently queuing — two concurrent PDF renders would otherwise raced two
// hidden BrowserWindows against the same in-flight flag.
export function isDocumentPdfExportInFlight(): boolean {
  return exportInFlight;
}

// Renders `html` to a PDF buffer in a hidden, sandboxed, preload-less
// BrowserWindow — the content is document markdown (a user's or an agent's
// own text), never trusted with Node or IPC access. The window (and its
// backing temp file) is ALWAYS cleaned up, even if load/print throws.
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  if (exportInFlight) {
    throw new Error("An export is already in progress.");
  }
  exportInFlight = true;
  let dir: string | null = null;
  let win: BrowserWindow | null = null;
  try {
    // A temp file (not a data: URL) so document size never runs into
    // Chromium's URL-length ceiling.
    dir = await mkdtemp(join(tmpdir(), "dohc-export-"));
    const filePath = join(dir, "document.html");
    await writeFile(filePath, html, "utf8");

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await win.loadFile(filePath);
    return await win.webContents.printToPDF(PDF_PRINT_OPTIONS);
  } finally {
    win?.destroy();
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    exportInFlight = false;
  }
}
