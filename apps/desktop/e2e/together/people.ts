// People on a share link, as headless browser pages. Everything here reads and does what a person
// can: the words on the page, clicks, and keys. Nothing reads the editor's or the server's state.
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import type { SharedNote } from "./stack";

/** What one person's page shows. */
export interface Seen {
  /** The note's lines, top to bottom, with spaces tidied. */
  lines: string[];
  /** Each to-do's box: "x" ticked, "_" not. */
  boxes: string;
  /** The page's own words about editing, such as "Changes saved". */
  words: string;
  /** The page no longer lets this person edit, or says editing stopped or paused. */
  stopped: boolean;
}

export interface Person {
  name: string;
  context: BrowserContext;
  page: Page;
  /**
   * Holds this person's live connection: nothing they do reaches the server, and nothing reaches
   * them, until `release`. It stands in for the moment before a change has crossed the network.
   */
  hold(): void;
  release(): void;
  sees(): Promise<Seen>;
}

const STOPPED = /stopped|paused|no longer|could not|cannot|can't/iu;

export const editor = (page: Page): Locator =>
  page.getByRole("textbox", { name: "Shared file editor", exact: true });

/** The note's lines in the editor: headings, paragraphs and to-do or list lines. */
export const lines = (page: Page): Locator => editor(page).locator("h1, h2, h3, p");

/** The line whose whole text is `text`. A line that only contains it, as after a join, is not it. */
export const line = (page: Page, text: string): Locator =>
  editor(page).getByText(text, { exact: true }).first();

async function seen(page: Page): Promise<Seen> {
  const words = (await page.locator('[role="status"], [role="alert"]').allInnerTexts())
    .map((text) => text.trim())
    .filter(Boolean)
    .join(" / ");
  const editable =
    (await editor(page)
      .getAttribute("contenteditable")
      .catch(() => null)) === "true";
  return {
    lines: (
      await lines(page)
        .allInnerTexts()
        .catch(() => [])
    ).map((text) => text.replace(/\s+/gu, " ").trim()),
    boxes: (
      await editor(page)
        .locator('input[type="checkbox"]')
        .evaluateAll((boxes) => boxes.map((box) => ((box as HTMLInputElement).checked ? "x" : "_")))
        .catch(() => [])
    ).join(""),
    words,
    stopped: !editable || STOPPED.test(words),
  };
}

/** Opens the link in a browser of its own, opens the note, and presses "Edit file". */
export async function openPerson(
  browser: Browser,
  note: SharedNote,
  name: string,
): Promise<Person> {
  const context = await browser.newContext();
  let held = false;
  const waiting: Array<() => void> = [];
  const pass = (send: () => void) => {
    if (held) waiting.push(send);
    else send();
  };
  await context.routeWebSocket(/\/api\/live\/link/u, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => pass(() => server.send(message)));
    server.onMessage((message) => pass(() => socket.send(message)));
  });
  const page = await context.newPage();
  await page.goto(note.link);
  await page.getByRole("button", { name: note.path, exact: true }).click();
  await page.getByRole("button", { name: "Edit file", exact: true }).click();
  await expect(editor(page), `${name} could not open the editor`).toHaveAttribute(
    "contenteditable",
    "true",
    { timeout: 60_000 },
  );
  return {
    name,
    context,
    page,
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      for (const send of waiting.splice(0)) {
        try {
          send();
        } catch {
          // The socket this was meant for has closed, so there is nowhere to deliver it.
        }
      }
    },
    sees: () => seen(page),
  };
}

/** Opens the link in a browser of its own and only reads the note, as someone who never presses "Edit file". */
export async function openReader(browser: Browser, note: SharedNote): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(note.link);
  await page.getByRole("button", { name: note.path, exact: true }).click();
  return page;
}

/**
 * Waits until the editor has the caret where a click or an arrow key just put it.
 *
 * The browser moves the caret at once but tells the page a frame later, and the editor takes its
 * caret from that news. A key pressed sooner acts where the caret was before: on a fresh page, a
 * Backspace sent straight after the first click did nothing in 4 of 8 tries. No person types
 * within a frame of a click, so the wait is two frames and one turn of the page's queue.
 */
export async function caretSettles(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }),
  );
}

/** Clicks, then waits until the editor has the caret there. */
export async function clickAt(target: Locator, position?: { x: number; y: number }): Promise<void> {
  await target.click(position ? { position } : {});
  await caretSettles(target.page());
}

/** Presses keys that move the caret or select, such as an arrow or Home, then waits for the editor to follow. */
export async function move(person: Person, ...keys: string[]): Promise<void> {
  for (const key of keys) await person.page.keyboard.press(key);
  await caretSettles(person.page);
}

/** Puts the caret at the end of a line, by clicking just inside its bottom right corner. */
export async function clickEndOf(target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("The line is not on the page.");
  await clickAt(target, { x: Math.max(1, box.width - 2), y: Math.max(1, box.height - 3) });
}

/** Puts the caret at the start of a line, by clicking just inside its top left corner. */
export async function clickStartOf(target: Locator): Promise<void> {
  await clickAt(target, { x: 1, y: 3 });
}

export async function type(person: Person, text: string): Promise<void> {
  await person.page.keyboard.type(text, { delay: 20 });
}

/** Waits until this person's page shows the text, which is when the change has reached them. */
export async function waitToSee(person: Person, text: string): Promise<void> {
  await expect(editor(person.page), `${person.name} never saw "${text}"`).toContainText(text, {
    timeout: 30_000,
  });
}

/**
 * Waits until the page has heard back from the server about everything this person did: it says
 * "Changes saved", or it says editing stopped.
 */
export async function waitForAnswer(person: Person): Promise<void> {
  await expect
    .poll(
      async () => {
        const now = await person.sees();
        return now.stopped || now.words.includes("Changes saved");
      },
      { message: `${person.name}'s page never heard back from the server`, timeout: 30_000 },
    )
    .toBe(true);
}
