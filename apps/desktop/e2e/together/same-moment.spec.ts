// Two people change the same place in a shared note at the same moment.
//
// Each case has three pages on one Edit link: two people who edit and one who only watches.
// One editor is held, so their change is made without the other's and reaches the server second.
import { expect, test as base } from "@playwright/test";
import { judge } from "./knownFaults";
import {
  clickAt,
  clickEndOf,
  clickStartOf,
  editor,
  line,
  lines,
  move,
  openPerson,
  type,
  waitForAnswer,
  waitToSee,
  type Person,
  type Seen,
} from "./people";
import { startTogetherStack, type TogetherStack } from "./stack";

/** The note's lines as every page shows them before anyone edits. */
const START = [
  "Together",
  "Alpha Apple",
  "Bravo Banana",
  "Charlie Cherry",
  "Delta Damson",
  "task Elder",
  "task Fig",
  "Omega ends the note.",
];
const NOTE = [
  "# Together",
  "",
  "Alpha Apple",
  "",
  "Bravo Banana",
  "",
  "Charlie Cherry",
  "",
  "Delta Damson",
  "",
  "- [ ] task Elder",
  "- [ ] task Fig",
  "",
  "Omega ends the note.",
  "",
].join("\n");

interface Scene {
  one: Person;
  two: Person;
  watcher: Person;
}
type Ending = Record<keyof Scene, Seen>;

// Every case here shares one server and gets a note of its own, so a case costs a note and
// three pages. No case stops or restarts the server.
let notes = 0;
const test = base.extend<{ scene: Scene }, { server: TogetherStack }>({
  server: [
    async ({}, use) => {
      const stack = await startTogetherStack();
      try {
        await use(stack);
      } finally {
        await stack.close();
      }
    },
    { scope: "worker" },
  ],
  scene: async ({ server }, use, info) => {
    const note = await server.shareNote(
      `note-${String(info.workerIndex)}-${String(++notes)}.md`,
      NOTE,
    );
    const people = {
      one: await openPerson(server.browser, note, "the first person"),
      two: await openPerson(server.browser, note, "the second person"),
      watcher: await openPerson(server.browser, note, "the person who only watches"),
    };
    try {
      await use(people);
    } finally {
      if (info.status !== info.expectedStatus)
        await info.attach("services", { contentType: "text/plain", body: server.output() });
      for (const person of Object.values(people)) await person.context.close();
    }
  },
});

/**
 * Lets the held person's change through and waits for the pages to settle: someone is told editing
 * stopped, or all three pages show the same note. Past the limit the pages are judged as they stand.
 */
async function ending(scene: Scene, held: Person): Promise<Ending> {
  await expect(held.page.getByText("Saving changes", { exact: false }).first()).toBeVisible();
  held.release();
  await waitForAnswer(held);
  const look = async (): Promise<Ending> => ({
    one: await scene.one.sees(),
    two: await scene.two.sees(),
    watcher: await scene.watcher.sees(),
  });
  const settled = ({ one, two, watcher }: Ending) =>
    one.stopped ||
    two.stopped ||
    watcher.stopped ||
    [two, watcher].every(
      (page) => page.boxes === one.boxes && page.lines.join("\n") === one.lines.join("\n"),
    );
  await expect
    .poll(async () => settled(await look()), { timeout: 20_000, intervals: [250] })
    .toBe(true)
    .catch(() => undefined);
  return await look();
}

const pages = (end: Ending): Seen[] => [end.one, end.two, end.watcher];
const count = (page: Seen, word: string): number => page.lines.join("\n").split(word).length - 1;
/** Some lines' text run together without spaces: what is there and in what order, whatever the line breaks. */
const run = (text: readonly string[], ...without: string[]): string =>
  without.reduce((joined, word) => joined.split(word).join(""), text.join("")).replace(/\s+/gu, "");

function everyoneStillEdits(end: Ending): void {
  expect(
    pages(end).map((page) => page.words),
    "someone was told editing stopped",
  ).toEqual(pages(end).map(() => expect.not.stringMatching(/stopped|paused/iu)));
  expect(pages(end).map((page) => page.stopped)).toEqual([false, false, false]);
}

/** Everyone still edits, and every page shows exactly these lines and boxes. */
function everyPageShows(end: Ending, expected: readonly string[], boxes = "__"): void {
  everyoneStillEdits(end);
  for (const page of pages(end)) {
    expect(page.lines).toEqual(expected);
    expect(page.boxes).toBe(boxes);
  }
}

/**
 * Everyone still edits and every page agrees. Nothing of the note is lost, doubled or out of
 * order, each new word is there once, and no box is ticked. Line breaks may fall anywhere, so a
 * fix is free to choose where a merged line ends.
 */
function nothingLost(end: Ending, ...words: string[]): void {
  everyoneStillEdits(end);
  for (const page of pages(end)) {
    expect(page.lines, "the pages differ").toEqual(end.one.lines);
    expect(run(page.lines, ...words)).toBe(run(START));
    for (const word of words) expect(count(page, word), word).toBe(1);
    expect(page.boxes).toBe("__");
  }
}

/** No page says that someone else's change removed text: the text followed the line it was in. */
function isToldNothingWasRemoved(end: Ending): void {
  for (const page of pages(end))
    expect(page.words).not.toContain("Someone else's change removed this text");
}

/** The page tells its person that someone else's change removed this text of theirs, and quotes it. */
function isToldOfRemoved(page: Seen, text: string): void {
  expect(page.words).toContain("Someone else's change removed this text");
  expect(page.words).toContain(text);
}

for (const makerFirst of [true, false]) {
  const name = `same new empty line, the line's maker ${makerFirst ? "first" : "second"}`;
  test(name, async ({ scene }) => {
    const { one, two, watcher } = scene;
    // The first person makes a new empty last line, and it reaches the second person's page.
    const before = await lines(two.page).count();
    await clickEndOf(lines(one.page).last());
    await one.page.keyboard.press("Enter");
    await expect(lines(two.page)).toHaveCount(before + 1);
    const [early, late] = makerFirst ? [one, two] : [two, one];
    const word = (person: Person) => (person === one ? "MAKERWORD" : "OTHERWORD");
    late.hold();
    // One of them types on the empty line and is saved. The other then types on the same line,
    // not having received that word.
    await clickAt(lines(early.page).last());
    await type(early, word(early));
    await waitToSee(watcher, word(early));
    await clickAt(lines(late.page).last());
    await type(late, word(late));

    judge(name, await ending(scene, late), (end) => nothingLost(end, "MAKERWORD", "OTHERWORD"));
  });
}

// Two people each add a line after the same last line, one a moment after the other. The second
// person presses Enter at the end of the last line of text when the first person's new empty line
// is already below it. Each then types, expecting a line of their own.
test("both add a line after the same last line, one just after the other", async ({ scene }) => {
  const name = "both add a line after the same last line, one just after the other";
  const { one, two, watcher } = scene;
  const before = await lines(two.page).count();
  await clickEndOf(line(one.page, "Omega ends the note."));
  await one.page.keyboard.press("Enter");
  await expect(lines(two.page)).toHaveCount(before + 1);
  await clickEndOf(line(two.page, "Omega ends the note."));
  await two.page.keyboard.press("Enter");
  for (const person of [one, two, watcher])
    await expect(lines(person.page)).toHaveCount(before + 2);
  // Each types where their caret is, the second not having received the first's word.
  two.hold();
  await type(one, "ONEWORD");
  await waitToSee(watcher, "ONEWORD");
  await type(two, "TWOWORD");

  judge(
    name,
    await ending(scene, two),
    (end) => {
      nothingLost(end, "ONEWORD", "TWOWORD");
      // Each word on a line of its own.
      for (const word of ["ONEWORD", "TWOWORD"]) expect(end.one.lines).toContain(word);
    },
    // The second person's caret was put in the first person's new line, so both typed on one
    // line, and the second person's own new line stays empty below it.
    (end) => {
      const joined = end.one.lines.includes("ONEWORDTWOWORD") ? "ONEWORDTWOWORD" : "TWOWORDONEWORD";
      everyPageShows(end, [...START, joined, ""]);
    },
  );
});

test("both press Enter at the end of the note, then each types", async ({ scene }) => {
  const { one, two, watcher } = scene;
  const before = await lines(watcher.page).count();
  // Both press Enter at the end of the same line, neither having received the other's.
  two.hold();
  await clickEndOf(line(one.page, "Omega ends the note."));
  await one.page.keyboard.press("Enter");
  await expect(lines(watcher.page)).toHaveCount(before + 1);
  await clickEndOf(line(two.page, "Omega ends the note."));
  await two.page.keyboard.press("Enter");
  two.release();
  for (const person of [one, two, watcher])
    await expect(lines(person.page)).toHaveCount(before + 2);
  // Each types where their caret is, the second not having received the first's word.
  two.hold();
  await type(one, "ONEWORD");
  await waitToSee(watcher, "ONEWORD");
  await type(two, "TWOWORD");

  judge(
    "both press Enter at the end of the note, then each types",
    await ending(scene, two),
    (end) => {
      nothingLost(end, "ONEWORD", "TWOWORD");
      for (const word of ["ONEWORD", "TWOWORD"]) expect(end.one.lines).toContain(word);
    },
  );
});

test("both type at the end of the same line", async ({ scene }) => {
  const { one, two, watcher } = scene;
  two.hold();
  await clickEndOf(line(one.page, "Bravo Banana"));
  await type(one, " ONEWORD");
  await waitToSee(watcher, "ONEWORD");
  await clickEndOf(line(two.page, "Bravo Banana"));
  await type(two, " TWOWORD");

  judge("both type at the end of the same line", await ending(scene, two), (end) => {
    nothingLost(end, "ONEWORD", "TWOWORD");
    // Both words are on that line, in either order, and no line was added.
    expect(end.one.lines).toHaveLength(START.length);
    expect(end.one.lines[2]).toMatch(/^Bravo Banana (ONEWORD TWOWORD|TWOWORD ONEWORD)$/u);
  });
});

test("both tick the same box", async ({ scene }) => {
  const { one, two, watcher } = scene;
  const firstBox = (person: Person) =>
    editor(person.page).locator('input[type="checkbox"]').first();
  two.hold();
  await firstBox(one).click();
  await expect(firstBox(watcher)).toBeChecked();
  await firstBox(two).click();

  judge("both tick the same box", await ending(scene, two), (end) =>
    everyPageShows(end, START, "x_"),
  );
});

/** The first person joins "Bravo Banana" to the line above with Backspace, and it reaches the watcher. */
async function firstJoinsBravo({ one, watcher }: Scene): Promise<void> {
  await clickStartOf(line(one.page, "Bravo Banana"));
  await one.page.keyboard.press("Backspace");
  await waitToSee(watcher, "Alpha AppleBravo Banana");
}
/** The note after one join of "Bravo Banana" to the line above, with that line as given. */
const joined = (first: string, ...then: string[]): string[] => [
  "Together",
  first,
  ...then,
  "Delta Damson",
  "task Elder",
  "task Fig",
  "Omega ends the note.",
];

test("both join the same line", async ({ scene }) => {
  const { two } = scene;
  two.hold();
  await firstJoinsBravo(scene);
  await clickStartOf(line(two.page, "Bravo Banana"));
  await two.page.keyboard.press("Backspace");

  judge("both join the same line", await ending(scene, two), (end) =>
    everyPageShows(end, joined("Alpha AppleBravo Banana", "Charlie Cherry")),
  );
});

test("joins of neighbouring lines", async ({ scene }) => {
  const { two } = scene;
  two.hold();
  await firstJoinsBravo(scene);
  await clickStartOf(line(two.page, "Charlie Cherry"));
  await two.page.keyboard.press("Backspace");

  judge("joins of neighbouring lines", await ending(scene, two), (end) => {
    everyPageShows(end, joined("Alpha AppleBravo BananaCharlie Cherry"));
    isToldNothingWasRemoved(end);
  });
});

test("a join and a split of one line", async ({ scene }) => {
  const { two } = scene;
  two.hold();
  await firstJoinsBravo(scene);
  // The second person splits the same line after its first word.
  await clickStartOf(line(two.page, "Bravo Banana"));
  await move(two, ...Array.from("Bravo", () => "ArrowRight"));
  await two.page.keyboard.press("Enter");

  judge("a join and a split of one line", await ending(scene, two), (end) =>
    everyPageShows(end, joined("Alpha AppleBravo", "Banana", "Charlie Cherry")),
  );
});

test("a join and typing in the joined line", async ({ scene }) => {
  const { two } = scene;
  two.hold();
  await firstJoinsBravo(scene);
  await clickEndOf(line(two.page, "Bravo Banana"));
  await type(two, " TYPEDWORD");

  judge("a join and typing in the joined line", await ending(scene, two), (end) => {
    everyPageShows(end, joined("Alpha AppleBravo Banana TYPEDWORD", "Charlie Cherry"));
    isToldNothingWasRemoved(end);
  });
});

/** Deletes a line as a person does: its text, then the empty line it leaves. */
async function deleteLine(person: Person, text: string): Promise<void> {
  await clickAt(line(person.page, text));
  await move(person, "Home", "Shift+End");
  await person.page.keyboard.press("Backspace");
  await person.page.keyboard.press("Backspace");
}
const without = (...gone: string[]): string[] => START.filter((text) => !gone.includes(text));

test("typing in a paragraph someone deletes", async ({ scene }) => {
  const { one, two, watcher } = scene;
  two.hold();
  await deleteLine(one, "Charlie Cherry");
  await expect(line(watcher.page, "Charlie Cherry")).toHaveCount(0);
  await clickEndOf(line(two.page, "Charlie Cherry"));
  await type(two, " TYPEDWORD");

  // The paragraph goes, and the word with it. Its author is told, and can copy it.
  judge("typing in a paragraph someone deletes", await ending(scene, two), (end) => {
    everyPageShows(end, without("Charlie Cherry"));
    isToldOfRemoved(end.two, "TYPEDWORD");
  });
});

test("one deletes a line while the other types at the end of the line above", async ({ scene }) => {
  const { one, two, watcher } = scene;
  two.hold();
  await deleteLine(one, "Charlie Cherry");
  await expect(line(watcher.page, "Charlie Cherry")).toHaveCount(0);
  await clickEndOf(line(two.page, "Bravo Banana"));
  await type(two, " TYPEDWORD");

  judge(
    "one deletes a line while the other types at the end of the line above",
    await ending(scene, two),
    (end) =>
      everyPageShows(
        end,
        without("Charlie Cherry").map((text) =>
          text === "Bravo Banana" ? "Bravo Banana TYPEDWORD" : text,
        ),
      ),
  );
});

test("both delete neighbouring lines", async ({ scene }) => {
  const { one, two, watcher } = scene;
  two.hold();
  await deleteLine(one, "Charlie Cherry");
  await expect(line(watcher.page, "Charlie Cherry")).toHaveCount(0);
  await deleteLine(two, "Delta Damson");

  judge("both delete neighbouring lines", await ending(scene, two), (end) =>
    everyPageShows(end, without("Charlie Cherry", "Delta Damson")),
  );
});

// On a share page, Enter at the end of a to-do starts a new line inside that to-do.
test("one starts a new line in a to-do while the other types at the end of it", async ({
  scene,
}) => {
  const { one, two, watcher } = scene;
  two.hold();
  await clickEndOf(line(one.page, "task Fig"));
  await one.page.keyboard.press("Enter");
  await one.page.keyboard.insertText("NEWLINE");
  await waitToSee(watcher, "NEWLINE");
  await clickEndOf(line(two.page, "task Fig"));
  await type(two, " TYPEDWORD");

  judge(
    "one starts a new line in a to-do while the other types at the end of it",
    await ending(scene, two),
    (end) => {
      nothingLost(end, "NEWLINE", "TYPEDWORD");
      expect(end.one.lines).toContain("task Fig TYPEDWORD");
    },
  );
});

test("both start a new line in the same to-do", async ({ scene }) => {
  const { one, two, watcher } = scene;
  two.hold();
  await clickEndOf(line(one.page, "task Fig"));
  await one.page.keyboard.press("Enter");
  await one.page.keyboard.insertText("ONELINE");
  await waitToSee(watcher, "ONELINE");
  await clickEndOf(line(two.page, "task Fig"));
  await two.page.keyboard.press("Enter");
  await two.page.keyboard.insertText("TWOLINE");

  judge("both start a new line in the same to-do", await ending(scene, two), (end) => {
    nothingLost(end, "ONELINE", "TWOLINE");
    for (const word of ["ONELINE", "TWOLINE"]) expect(end.one.lines).toContain(word);
  });
});

// Two people adding to the end of the same place: the first presses Enter, and before they have
// typed, the second presses Enter on that new empty line too.
for (const [where, lastLine] of [
  ["at the end of the note", "Omega ends the note."],
  ["at the end of a to-do", "task Fig"],
] as const) {
  const name = `one presses Enter on a new empty line ${where} while its maker types in it`;
  test(name, async ({ scene }) => {
    const { one, two, watcher } = scene;
    // The first person makes a new empty line, and it reaches the others.
    const before = await lines(two.page).count();
    await clickEndOf(line(one.page, lastLine));
    await one.page.keyboard.press("Enter");
    await expect(lines(two.page)).toHaveCount(before + 1);
    one.hold();
    // The second person clicks that empty line, presses Enter, and types.
    await clickAt(lines(two.page).nth(START.indexOf(lastLine) + 1));
    await two.page.keyboard.press("Enter");
    await type(two, "OTHERWORD");
    await waitToSee(watcher, "OTHERWORD");
    // Its maker, who has not received any of that, types in it.
    await type(one, "MAKERWORD");

    judge(name, await ending(scene, one), (end) => {
      if (lastLine === "Omega ends the note.") return nothingLost(end, "MAKERWORD", "OTHERWORD");
      // Enter on an empty line inside a to-do moves that line out of the to-do, which removes
      // what its maker typed in it. The maker is told, and can copy the word.
      everyPageShows(end, [
        ...START.slice(0, START.indexOf(lastLine) + 1),
        "OTHERWORD",
        ...START.slice(START.indexOf(lastLine) + 1),
      ]);
      isToldOfRemoved(end.one, "MAKERWORD");
    });
  });
}
