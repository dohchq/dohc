import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openEditLinkOnServer } from "./helpers/editLinkServer";

const PATH = "plain.md";
const PARAGRAPH = "An ordinary paragraph.";

/** What a link holder's page says for `ms` after a restart, each distinct text with the second it first showed. */
async function watchPage(page: Page, label: string, ms: number): Promise<string[]> {
  const started = Date.now(),
    seen: string[] = [];
  let last = "";
  while (Date.now() - started < ms) {
    const text = await page
      .evaluate(() => {
        const says = [...document.querySelectorAll('[role="alert"], [role="status"], main.state')]
          .map((node) => (node as HTMLElement).innerText.trim().replaceAll(/\s+/gu, " "))
          .filter(Boolean);
        const editor = document.querySelector('[aria-label="Shared file editor"]');
        return `${editor ? `editor ${editor.getAttribute("contenteditable")}` : "no editor"} | ${says.join(" / ")}`;
      })
      .catch((error) => `page error: ${String(error).slice(0, 120)}`);
    if (text !== last) {
      last = text;
      seen.push(`${label} +${String(Math.round((Date.now() - started) / 1000))}s ${text}`);
      console.log(seen.at(-1));
    }
    await page.waitForTimeout(500);
  }
  return seen;
}

test("@server-restart an open Edit link loses nothing typed through a share service restart, a relay restart and both", async () => {
  test.setTimeout(900_000);
  const server = await openEditLinkOnServer({
    workspaceId: "server-restart-open-editor",
    owner: "e2e-server-restart-owner",
    path: PATH,
    files: [{ path: PATH, contents: `# Plain\n\n${PARAGRAPH}\n` }],
    env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" },
  });
  try {
    const { linkPage: browserPage, editor } = server;
    const ownerFile = () => readFile(join(server.workspaceRoot, PATH), "utf8").catch(() => "");
    // The page notes every whole word its editor ever holds. Keystrokes that arrive while the editor is being
    // replaced never enter the document, and only a word the editor held can have been dropped.
    await browserPage.evaluate(() => {
      const held = new Set<string>();
      (window as unknown as { heldWords: Set<string> }).heldWords = held;
      const note = () => {
        const editor = document.querySelector('[aria-label="Shared file editor"]');
        for (const word of (editor as HTMLElement | null)?.innerText.match(/w\d{4}/gu) ?? [])
          held.add(word);
      };
      new MutationObserver(note).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    // A link holder who goes on typing a new word about four times a second, whenever the page lets them.
    const typed: string[] = [];
    let typing = true;
    const typist = (async () => {
      for (let word = 0; typing; word++) {
        const text = ` w${String(word).padStart(4, "0")}`;
        try {
          if ((await editor.getAttribute("contenteditable", { timeout: 1_000 })) === "true") {
            await editor.getByText(PARAGRAPH, { exact: false }).click({ timeout: 1_000 });
            await browserPage.keyboard.press("Control+End");
            await browserPage.keyboard.insertText(text);
            typed.push(text);
          }
        } catch {
          // The page had no editor to type in at that moment.
        }
        await browserPage.waitForTimeout(250);
      }
    })();
    const phase = async (label: string, restart: () => Promise<void>, watchMs: number) => {
      const before = typed.length;
      await browserPage.waitForTimeout(3_000);
      const restartedAt = typed.length;
      await restart();
      const said = await watchPage(browserPage, label, watchMs);
      console.log(
        `${label}: restarted after${typed[restartedAt - 1] ?? " nothing"}; ${String(restartedAt - before)} words typed before it, ${String(typed.length - restartedAt)} after`,
      );
      return said;
    };

    // A word is at risk only in the moment a restart cuts the page's connection, so a hunt for a lost word asks
    // for many share service restarts with DOHC_SERVER_RESTARTS.
    const shareServiceRestarts = Number(process.env.DOHC_SERVER_RESTARTS ?? 1);
    const said: string[][] = [];
    for (let restart = 1; restart <= shareServiceRestarts; restart++)
      said.push(
        await phase(
          `share service ${String(restart)}`,
          async () => server.restartShareService(),
          6_000,
        ),
      );
    // A real restart takes the share service away for some seconds, and the page tries less often the longer
    // it is away. The page must be editing again soon after the service is back, not one long wait later.
    let editingAfterMs = 0;
    said.push(
      await phase(
        "share service, 9 s away",
        async () => {
          const returned = server.restartShareServiceAfter(9_000);
          // While the service is away the page takes no typing, so the wait below measures a real return.
          await expect(editor).not.toHaveAttribute("contenteditable", "true", { timeout: 8_000 });
          await returned;
          const returnedAt = Date.now();
          await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 60_000 });
          editingAfterMs = Date.now() - returnedAt;
        },
        3_000,
      ),
    );
    console.log(
      `share service, 9 s away: editing again ${String(editingAfterMs)} ms after the service returned`,
    );
    said.push(await phase("relay", () => server.restartRelay(), 20_000));
    // A deploy stops both, and the relay is back some seconds after the share service.
    said.push(
      await phase(
        "whole server",
        () =>
          server.restartRelay(async () => {
            server.restartShareService();
            await browserPage.waitForTimeout(10_000);
          }),
        20_000,
      ),
    );
    typing = false;
    await typist;

    // Every word the page accepted reaches the owner's file, in the order typed.
    let missing: string[] = typed;
    await expect
      .poll(
        async () => {
          const file = await ownerFile();
          missing = typed.filter((word) => !file.includes(word));
          return missing.length;
        },
        { timeout: 180_000, intervals: [2_000] },
      )
      .toBe(0)
      .catch(() => undefined);
    const file = await ownerFile();
    const inOrder = typed
      .filter((word) => file.includes(word))
      .every(
        (word, index, kept) => index === 0 || file.indexOf(kept[index - 1]!) < file.indexOf(word),
      );
    console.log(
      `typed ${String(typed.length)} words; missing from the owner's file: ${String(missing.length)} ${missing.slice(0, 12).join("")}; in order: ${String(inOrder)}`,
    );
    const held = new Set(
      await browserPage.evaluate(() => [
        ...(window as unknown as { heldWords: Set<string> }).heldWords,
      ]),
    );
    const shown = await editor.innerText().catch(() => "");
    const dropped = missing.filter((word) => held.has(word.trim()));
    console.log(
      `the editor held ${String(held.size)} of ${String(typed.length)} typed words; missing and once held (dropped): ${dropped.join("") || "none"}; missing and never held: ${missing.filter((word) => !held.has(word.trim())).join("") || "none"}; missing and still shown: ${missing.filter((word) => shown.includes(word.trim())).join("") || "none"}`,
    );
    const editable = await editor.getAttribute("contenteditable").catch(() => null);
    // Typing that arrived while the editor was being replaced went nowhere and is reported above, not failed here.
    expect({ dropped, inOrder, editable, said }).toMatchObject({
      dropped: [],
      inOrder: true,
      editable: "true",
    });
    // The page waits at most 2 s between failed attempts in its first minute away, and an open takes about a
    // second here.
    expect(editingAfterMs).toBeLessThan(5_000);
  } finally {
    await server.close();
  }
});
