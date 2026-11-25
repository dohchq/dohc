// Several people make ordinary edits on one note for some minutes.
//
// At the end nobody was stopped, every page shows the same note, no typed word is missing, and
// what the server stores is what the pages show. knownFaults.ts lists the edits this run leaves
// out while a known fault makes them fail by chance.
//
// TOGETHER_MINUTES, TOGETHER_PEOPLE and TOGETHER_SEED change the run's length, size and choices.
// TOGETHER_EDITS limits it to some kinds of edit, such as "addLine,typeWord", to find which
// ones collide. TOGETHER_EVENTS names a file to write what everyone did to.
import { writeFileSync } from "node:fs";
import { expect, type Locator } from "@playwright/test";
import { LEFT_OUT } from "./knownFaults";
import {
  caretSettles,
  clickAt,
  clickEndOf,
  clickStartOf,
  editor,
  lines,
  move,
  openPerson,
  openReader,
  type Person,
  type Seen,
} from "./people";
import { test } from "./test";

const MINUTES = Number(process.env.TOGETHER_MINUTES ?? 1);
const PEOPLE = Number(process.env.TOGETHER_PEOPLE ?? 3);
const SEED = Number(process.env.TOGETHER_SEED ?? 41);

/** A paragraph and a to-do for each person, for the edits that are kept apart while a fault is open. */
const OWN_LINES = ["Alpha keeps", "Bravo keeps", "Charlie keeps", "Delta keeps"];
const NOTE = [
  "# Together",
  "",
  ...OWN_LINES.flatMap((start) => [`${start} these words.`, ""]),
  "- [ ] task one",
  "- [ ] task two",
  "- [ ] task three",
  "- [ ] task four",
  "",
  "Omega ends the note.",
  "",
].join("\n");

/** A word one person typed. It is pasted whole, so letters typed by others at the same spot cannot split it. */
interface Typed {
  word: string;
  by: number;
  /** A line made to be deleted that held this word's line when it was typed, if any. */
  doomed: string | null;
}

/** A small seeded generator, so a run's choices can be made again. */
function chooser(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
}

test(`${String(PEOPLE)} people make ordinary edits for ${String(MINUTES)} minutes`, async ({
  stack,
}) => {
  test.setTimeout(MINUTES * 60_000 + 300_000);
  const note = await stack.shareNote("note.md", NOTE);
  const people: Person[] = [];
  for (let index = 0; index < PEOPLE; index++)
    people.push(await openPerson(stack.browser, note, `person ${String(index + 1)}`));
  const watcher = await openPerson(stack.browser, note, "the person who only watches");
  // A line someone reaches for can be cleared by another person first. Without a limit the
  // click would wait for that line until the test ends; a person looks for two seconds and moves on.
  for (const person of people) person.page.setDefaultTimeout(2_000);
  const serverErrors: string[] = [];
  for (const person of [...people, watcher])
    person.page.on("response", (response) => {
      if (response.status() >= 500)
        serverErrors.push(`${String(response.status())} ${new URL(response.url()).pathname}`);
    });

  const typed: Typed[] = [];
  /** Lines made to be deleted, and the ones deleted so far. */
  const doomed = new Set<string>();
  const deleted = new Set<string>();
  /** The text of each deleted line as the person deleting it saw it. */
  const deletedText: string[] = [];
  let serial = 0;
  /** What each person did and when, to explain a word that goes missing. `by` -1 is the watcher's page. */
  const events: Array<{ at: number; by: number; did: string }> = [];
  const began = Date.now();
  const log = (by: number, what: string) => events.push({ at: Date.now() - began, by, did: what });
  const did: Record<string, number> = {};
  const failed: Record<string, number> = {};
  const apart = LEFT_OUT["starting a new line where someone else starts one"] !== undefined;
  const joins = LEFT_OUT["joining and splitting lines"] === undefined;

  const actions = (person: Person, by: number, random: () => number) => {
    const page = person.page;
    /** A line of the note, and one with text in it while typing on an empty line is left out. */
    const anyLine = async (): Promise<Locator> => {
      const texts = await lines(page).allInnerTexts();
      const usable = texts.flatMap((text, index) =>
        LEFT_OUT["typing on a line that is empty"] && !text.trim() ? [] : [index],
      );
      return lines(page).nth(usable[Math.floor(random() * usable.length)] ?? 0);
    };
    const word = () => `w${String(by)}n${String(++serial)}q`;
    // Other people's edits can move the note between aiming a click and landing it, so a click
    // can land on the line next to the one meant. Each edit therefore reads back where the caret
    // or the selection really is, and records that. A person looks before they type, too.
    const caretLine = () =>
      page.evaluate(() => {
        const node = window.getSelection()?.anchorNode;
        const element = node instanceof Element ? node : node?.parentElement;
        const block = element?.closest("p, h1, h2, h3");
        return block ? { text: block.textContent ?? "", todo: block.closest("li") !== null } : null;
      });
    const missed = () => new Error("The note moved under the click.");
    return {
      async typeWord() {
        await clickEndOf(await anyLine());
        const host = (await caretLine())?.text ?? "";
        if (LEFT_OUT["typing on a line that is empty"] && !host.trim()) throw missed();
        const pasted = word();
        await page.keyboard.insertText(` ${pasted}`);
        typed.push({
          word: pasted,
          by,
          doomed: [...doomed].find((id) => host.includes(id)) ?? null,
        });
        log(by, `typed ${pasted} at the end of "${host.slice(-40)}"`);
      },
      /** A new line with text: after this person's own paragraph while new lines are kept apart, else at the end of the note. */
      async addLine() {
        if (apart && by >= OWN_LINES.length) return;
        const after = apart
          ? lines(page).filter({ hasText: OWN_LINES[by] }).first()
          : lines(page).last();
        // The closing letter keeps one marker from being the start of another.
        const id = `DOOMED${String(by)}x${String(++serial)}z`;
        await clickEndOf(after);
        if (apart && !(await caretLine())?.text.includes(OWN_LINES[by]!)) throw missed();
        await move(person, "Enter");
        await page.keyboard.insertText(`${id} is here to be deleted`);
        doomed.add(id);
        // The marker is accounted for like any typed word, until someone deletes its line.
        typed.push({ word: id, by, doomed: null });
        log(by, `added the line ${id}`);
      },
      /** Deletes a line made for it: its text, and then the emptied line, which is a join. */
      async deleteLine() {
        const id = [...doomed].find((candidate) => !deleted.has(candidate));
        if (!id) return;
        const target = lines(page).filter({ hasText: id }).first();
        if (!(await target.count())) return;
        // A triple click selects the whole paragraph, however far it has wrapped.
        await target.click({ clickCount: 3 });
        await caretSettles(page);
        const text = await page.evaluate(() => window.getSelection()?.toString() ?? "");
        if (!text.includes(id)) {
          await page.keyboard.press("ArrowLeft");
          throw missed();
        }
        deletedText.push(text);
        await page.keyboard.press("Backspace");
        await caretSettles(page);
        // Only on an empty line: on a line that still has text, a second Backspace would eat the
        // last letter of the line above.
        const emptied = await page.evaluate(() => {
          const node = window.getSelection()?.anchorNode;
          const element = node instanceof Element ? node : node?.parentElement;
          return element?.closest("p, h1, h2, h3")?.textContent === "";
        });
        if (joins && emptied) await page.keyboard.press("Backspace");
        deleted.add(id);
        log(by, `deleted "${text.slice(0, 60)}"${joins && emptied ? " and its line" : ""}`);
      },
      async tick() {
        const boxes = editor(page).locator('input[type="checkbox"]');
        const count = await boxes.count();
        if (count) await boxes.nth(Math.floor(random() * count)).click();
      },
      async split() {
        const target = await anyLine();
        const text = await target.innerText();
        await clickAt(target);
        // To the next word's edge, so the break never falls inside a word.
        await move(person, "Control+ArrowRight");
        await move(person, "Enter");
        log(by, `split "${text.slice(0, 50)}"`);
      },
      async join() {
        const count = await lines(page).count();
        if (count < 3) return;
        const target = lines(page).nth(1 + Math.floor(random() * (count - 1)));
        const text = await target.innerText();
        await clickStartOf(target);
        await page.keyboard.press("Backspace");
        log(by, `joined "${text.slice(0, 50)}" to the line above`);
      },
      /** A new line inside a to-do: this person's own to-do while new lines are kept apart, else the last one. */
      async addToTodo() {
        const items = editor(page).locator("li");
        const count = await items.count();
        if (!count || (apart && by >= count)) return;
        const item = apart ? items.nth(by) : items.last();
        const pasted = word();
        const after = await item.locator("p").last().innerText();
        await clickEndOf(item.locator("p").last());
        const landed = await caretLine();
        if (!landed?.todo || landed.text.trim() !== after.trim()) throw missed();
        await move(person, "Enter");
        await page.keyboard.insertText(pasted);
        typed.push({ word: pasted, by, doomed: null });
        log(by, `added ${pasted} as a new line in the to-do "${after.slice(-40)}"`);
      },
    };
  };
  const mix = [
    "typeWord",
    "typeWord",
    "typeWord",
    "typeWord",
    "tick",
    "tick",
    "addLine",
    "deleteLine",
    "split",
    "join",
    "addToTodo",
  ] as const;
  const only = (process.env.TOGETHER_EDITS ?? "").split(",").filter(Boolean);
  const chosen = mix.filter(
    (kind) =>
      (joins || (kind !== "join" && kind !== "split")) && (!only.length || only.includes(kind)),
  );

  const until = Date.now() + MINUTES * 60_000;
  // The watcher's page, read twice a second: when it last showed each word, and what stood
  // around a word when it went. A missing word is reported with what everyone did at that moment.
  const lastSeen = new Map<string, number>();
  let watching = true;
  const watch = (async () => {
    let earlier: string[] = [];
    while (watching) {
      const now = await lines(watcher.page)
        .allInnerTexts()
        .catch(() => earlier);
      const text = now.join("\n");
      for (const { word } of typed) {
        if (text.includes(word)) {
          lastSeen.set(word, Date.now() - began);
          continue;
        }
        const at = earlier.findIndex((entry) => entry.includes(word));
        if (at >= 0)
          log(
            -1,
            `lost ${word}: its line was "${earlier[at]!.slice(-70)}"; lines there now ${JSON.stringify(now.slice(Math.max(0, at - 1), at + 2).map((entry) => entry.slice(-40)))}`,
          );
      }
      earlier = now;
      // How often the watcher's page is read.
      await watcher.page.waitForTimeout(500);
    }
  })();
  const stoppedAt = new Map<number, string>();
  await Promise.all(
    people.map(async (person, by) => {
      const random = chooser(SEED + by);
      const act = actions(person, by, random);
      while (Date.now() < until) {
        const now = await person.sees();
        if (now.stopped) {
          stoppedAt.set(
            by,
            `${now.words} (${String(Math.round((until - Date.now()) / 1000))} s before the end)`,
          );
          const others = await watcher.sees();
          log(
            by,
            `was stopped; the end of their page ${JSON.stringify(now.lines.slice(-5))}; the end of the watcher's page ${JSON.stringify(others.lines.slice(-5))}`,
          );
          return;
        }
        const kind = chosen[Math.floor(random() * chosen.length)]!;
        try {
          await act[kind]();
          did[kind] = (did[kind] ?? 0) + 1;
        } catch {
          // The note moved under this person's hand: the line they reached for was joined, split
          // or deleted by someone else first. A person would just try the next thing.
          failed[kind] = (failed[kind] ?? 0) + 1;
        }
        // A person's pause between one edit and the next.
        await person.page.waitForTimeout(150 + random() * 450);
      }
    }),
  );

  // The pages still editing settle: none is still saving, and all show the same note.
  const editing = people.filter((_, by) => !stoppedAt.has(by));
  const look = async (): Promise<Seen[]> =>
    await Promise.all([...editing, watcher].map((person) => person.sees()));
  const same = (pages: Seen[]) =>
    pages.every(
      (page) =>
        page.boxes === pages[0]!.boxes && page.lines.join("\n") === pages[0]!.lines.join("\n"),
    );
  await expect
    .poll(
      async () => {
        const pages = await look();
        return same(pages) && pages.every((page) => !page.words.includes("Saving"));
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true)
    .catch(() => undefined);
  const pages = await look();
  const shown = pages[0]!.lines.join("\n");
  // Someone stopped by their last edit, and the person who only watches.
  for (const [by, person] of people.entries()) {
    const now = await person.sees();
    if (now.stopped && !stoppedAt.has(by)) stoppedAt.set(by, `${now.words} (at the end)`);
  }
  const watched = await watcher.sees();

  // What the server stores, as a new reader's page shows it and as the file itself.
  const reader = await openReader(stack.browser, note);
  const article = reader.locator("article.markdown");
  const readerLines = async () =>
    (await article.innerText())
      .split("\n")
      .map((text) => text.replace(/\s+/gu, " ").trim())
      .filter(Boolean);
  const pageLines = pages[0]!.lines.filter(Boolean);
  await expect
    .poll(async () => (await readerLines()).join("\n"), { timeout: 60_000, intervals: [1000] })
    .toBe(pageLines.join("\n"))
    .catch(() => undefined);
  const stored = await readerLines();
  // The reader's page draws no boxes, so the ticks are compared with the stored file's.
  const fileBoxes = (markdown: string) =>
    [...markdown.matchAll(/^\s*[-*+] \[([ xX])\] /gmu)]
      .map((match) => (match[1] === " " ? "_" : "x"))
      .join("");
  await expect
    .poll(async () => fileBoxes(await stack.storedFile(note)), { timeout: 60_000 })
    .toBe(pages[0]!.boxes)
    .catch(() => undefined);
  const file = await stack.storedFile(note);
  watching = false;
  await watch;

  // Every word typed by someone still editing, by where it ended up.
  const fate = {
    kept: 0,
    deletedOnPurpose: 0,
    goneWithALine: 0,
    lost: [] as string[],
    doubled: [] as string[],
  };
  for (const { word, by, doomed: host } of typed) {
    if (stoppedAt.has(by)) continue;
    const count = shown.split(word).length - 1;
    if (count === 1) fate.kept++;
    else if (count > 1) fate.doubled.push(word);
    else if (deletedText.some((text) => text.includes(word))) fate.deletedOnPurpose++;
    // Typed into a line that someone else then deleted without seeing the word. Its author is
    // told by a notice, which "typing in a paragraph someone deletes" checks.
    else if (host && deleted.has(host)) fate.goneWithALine++;
    else fate.lost.push(word);
  }
  const report = {
    minutes: MINUTES,
    people: PEOPLE,
    seed: SEED,
    did,
    failed,
    stopped: [
      ...[...stoppedAt.entries()].map(([by, words]) => `person ${String(by + 1)}: ${words}`),
      ...(watched.stopped ? [`the person who only watches: ${watched.words}`] : []),
    ],
    pagesAgree: same(pages),
    readerAgrees: stored.join("\n") === pageLines.join("\n"),
    words: { typed: typed.length, ...fate },
    serverErrors,
  };
  console.log(`ordinary edits: ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: "ordinary edits", description: JSON.stringify(report) });
  const told = (event: (typeof events)[number]) =>
    `${(event.at / 1000).toFixed(1)} s ${event.by < 0 ? "the watcher's page" : `person ${String(event.by + 1)}`} ${event.did}`;
  const everything = events.map(told).join("\n");
  await test.info().attach("what everyone did", { contentType: "text/plain", body: everything });
  if (process.env.TOGETHER_EVENTS) writeFileSync(process.env.TOGETHER_EVENTS, everything);
  // For each word that is missing or doubled: what everyone did around the moment it went.
  for (const word of [...fate.lost, ...fate.doubled]) {
    const typedAt = events.find((event) => event.did.includes(` ${word} `))?.at ?? 0;
    const seen = lastSeen.get(word);
    const from = seen ?? typedAt;
    console.log(
      [
        `${word}: typed at ${(typedAt / 1000).toFixed(1)} s, ${seen === undefined ? "never reached the watcher's page" : `last on the watcher's page at ${(seen / 1000).toFixed(1)} s`}`,
        ...events
          .filter((event) => event.at >= from - 2500 && event.at <= from + 3500)
          .map((event) => `  ${told(event)}`),
      ].join("\n"),
    );
  }

  expect(report.pagesAgree, `the pages still editing differ: ${JSON.stringify(pages)}`).toBe(true);
  expect(stored, "a new reader's page differs from the pages still editing").toEqual(pageLines);
  for (const { word, by } of typed)
    if (!stoppedAt.has(by) && shown.split(word).length - 1 === 1)
      expect(file, `${word} is on the pages and not in the stored file`).toContain(word);
  expect(fileBoxes(file), "the stored file's ticked boxes differ from the pages'").toBe(
    pages[0]!.boxes,
  );
  expect(serverErrors).toEqual([]);
  const acted = Object.values(did).reduce((sum, count) => sum + count, 0);
  const missed = Object.values(failed).reduce((sum, count) => sum + count, 0);
  expect(missed, "too many edits did not find their line; the run proves little").toBeLessThan(
    acted / 4,
  );
  expect(report.stopped, "someone was told editing stopped").toEqual([]);
  expect({ lost: fate.lost, doubled: fate.doubled }).toEqual({ lost: [], doubled: [] });
});
