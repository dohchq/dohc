// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { configureDemoDesktopBridge } from "./demoDesktopBridge";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

it.each([
  ["markdown", "welcome.md", "text/markdown"],
  ["html", "welcome.html", "text/html"],
] as const)("saves a %s export as a download named after the document", async (kind, name, type) => {
  const blobs: Blob[] = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      blobs.push(blob);
      return "blob:demo-export";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  const downloads: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  configureDemoDesktopBridge({
    documents: [],
    folders: [],
    createFile: () => undefined,
    createFolder: () => undefined,
    movePath: () => undefined,
    deletePath: () => undefined,
  });

  await expect(
    window.dohcDesktop!.exportDocumentFile({
      workspaceId: "marketing-demo",
      suggestedName: "welcome",
      content: "# Welcome\n",
      kind,
    }),
  ).resolves.toEqual({ path: null });

  expect(downloads).toEqual([name]);
  expect(blobs[0]?.type).toBe(type);
  expect(await blobs[0]?.text()).toBe("# Welcome\n");
});
