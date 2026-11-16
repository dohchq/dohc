// The server's parts stop and start again under open pages.
import { expect } from "@playwright/test";
import { judge } from "./knownFaults";
import {
  clickEndOf,
  editor,
  lines,
  openPerson,
  openReader,
  type,
  type Person,
  type Seen,
} from "./people";
import { test } from "./test";

const NOTE = [
  "# Together",
  "",
  "Alpha Apple",
  "",
  "Bravo Banana",
  "",
  "Omega ends the note.",
  "",
].join("\n");

/** Types a word at the end of the person's own line, and checks that their page shows it. */
async function typeWord(person: Person, ownLine: string, word: string): Promise<void> {
  await clickEndOf(lines(person.page).filter({ hasText: ownLine }).first());
  await type(person, ` ${word}`);
  await expect(editor(person.page), `${person.name}'s page never showed ${word}`).toContainText(
    word,
  );
}

const canEdit = async (person: Person): Promise<boolean> => !(await person.sees()).stopped;

test("the relay is killed and started again while two people type", async ({ stack }) => {
  const note = await stack.shareNote("note.md", NOTE);
  const one = await openPerson(stack.browser, note, "the first person");
  const two = await openPerson(stack.browser, note, "the second person");
  const words: string[] = [];
  const both = async (round: string) => {
    for (const [person, ownLine] of [
      [one, "Alpha Apple"],
      [two, "Bravo Banana"],
    ] as const) {
      const word = `${person === one ? "ONE" : "TWO"}${round}`;
      await typeWord(person, ownLine, word);
      words.push(word);
    }
  };
  await both("BEFORE1");
  await both("BEFORE2");
  for (const person of [one, two])
    await expect(person.page.getByText("Changes saved", { exact: true })).toBeVisible();

  // The relay goes while the first person's newest word has not left their page: their
  // connection is held, and the page says it is still saving. The second person's newest word
  // may or may not have arrived.
  one.hold();
  await both("ATKILL");
  await expect(one.page.getByText("Saving changes", { exact: false }).first()).toBeVisible();
  await stack.killRelay();
  one.release();
  for (const person of [one, two])
    await expect
      .poll(() => canEdit(person), { message: `${person.name} was never told` })
      .toBe(false);
  await stack.startRelay();

  // Each page comes back by itself, and each person's next word reaches the other.
  for (const person of [one, two])
    await expect
      .poll(() => canEdit(person), {
        message: `${person.name}'s page did not come back`,
        timeout: 90_000,
      })
      .toBe(true);
  await both("AFTER");
  await expect(editor(one.page)).toContainText("TWOAFTER", { timeout: 60_000 });
  await expect(editor(two.page)).toContainText("ONEAFTER", { timeout: 60_000 });

  // No word that a page showed is missing: not from the two pages, a new reader's page, or the stored file.
  const reader = await openReader(stack.browser, note);
  await expect(reader.locator("body")).toContainText("TWOAFTER", { timeout: 60_000 });
  await expect.poll(() => stack.storedFile(note), { timeout: 60_000 }).toContain("TWOAFTER");
  const [first, second] = [await one.sees(), await two.sees()];
  const places: Record<string, string> = {
    "the first person's page": first.lines.join("\n"),
    "the second person's page": second.lines.join("\n"),
    "a new reader's page": await reader.locator("body").innerText(),
    "the stored file": await stack.storedFile(note),
  };
  for (const [place, text] of Object.entries(places))
    for (const word of words) expect(text.split(word).length - 1, `${word} in ${place}`).toBe(1);
  expect(second.lines).toEqual(first.lines);
  expect([first.stopped, second.stopped]).toEqual([false, false]);
});

test("the share page's server restarts under open pages", async ({ stack }) => {
  const name = "the share page's server restarts under open pages";
  const note = await stack.shareNote("note.md", NOTE);
  const person = await openPerson(stack.browser, note, "the person editing");
  const reader = await openReader(stack.browser, note);
  await typeWord(person, "Alpha Apple", "BEFORE");
  await expect(person.page.getByText("Changes saved", { exact: true })).toBeVisible();
  await expect(reader.locator("body")).toContainText("BEFORE", { timeout: 60_000 });

  await stack.restartShareService();

  // The person editing ends one of two ways: their page lets them edit again, or it says editing is over.
  const over = /no longer available|Editing stopped/u;
  let editing: Seen = await person.sees();
  await expect
    .poll(
      async () => {
        editing = await person.sees();
        return !editing.stopped || over.test(editing.words);
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  if (!editing.stopped) {
    await typeWord(person, "Alpha Apple", "AFTER");
    editing = await person.sees();
  }
  // The person reading ends one of two ways: their page shows the new word, or it says the link is gone.
  // The page asks the server for news about every 30 seconds, so either can take that long.
  const gone = "This link isn't available.";
  let reading = "";
  await expect
    .poll(
      async () => {
        reading = await reader.locator("body").innerText();
        return reading.includes(gone) || reading.includes("AFTER");
      },
      { timeout: 90_000 },
    )
    .toBe(true)
    .catch(() => undefined);

  judge(name, { editing, reading }, (end) => {
    expect(end.editing.stopped, `the person editing was told: ${end.editing.words}`).toBe(false);
    expect(end.reading).not.toContain(gone);
    expect(end.reading).toContain("AFTER");
  });
  const fresh = await openReader(stack.browser, note);
  await expect(fresh.locator("body")).toContainText("AFTER", { timeout: 60_000 });
});
