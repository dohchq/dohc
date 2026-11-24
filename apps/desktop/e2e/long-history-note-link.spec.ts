import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openEditLinkOnServer } from "./helpers/editLinkServer";

const PATH = "Long history.md";
const SAVES = 100;

test("@long-history a note saved a hundred times from outside opens from an Edit link and takes an edit", async () => {
  test.setTimeout(600_000);
  let file = "# Long history\n\nTyped by the owner.\n";
  const server = await openEditLinkOnServer({
    workspaceId: "long-history-note",
    owner: "e2e-long-history-owner",
    path: PATH,
    files: [{ path: PATH, contents: file }],
    async beforeLink(ownerPage, workspaceRoot) {
      for (let save = 1; save <= SAVES; save++) {
        file += `Line ${String(save)} saved on its own.\n`;
        await writeFile(join(workspaceRoot, PATH), file);
        await expect(ownerPage.getByTestId("markdown-editor")).toContainText(
          `Line ${String(save)} saved on its own.`,
        );
      }
    },
  });
  try {
    const marker = `linkedit${randomBytes(4).toString("hex")}`;
    await server.editor.getByText(`Line ${String(SAVES)} saved on its own.`).click();
    await server.linkPage.keyboard.press("End");
    await server.linkPage.keyboard.type(` ${marker}`);
    await expect
      .poll(() => readFile(join(server.workspaceRoot, PATH), "utf8"), { timeout: 60_000 })
      .toContain(marker);
  } finally {
    await server.close();
  }
});
