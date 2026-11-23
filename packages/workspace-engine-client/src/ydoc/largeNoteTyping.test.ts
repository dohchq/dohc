import { expect, it } from "vitest";
import * as Y from "yjs";
import { YdocLoopbackEngine } from "../testing/ydocLoopbackEngine";
import { openEngineYdocProviderSession } from "./ydocProviderSession";

const KEYS = 41;

async function keystrokeMedianMs(paragraphs: number, words = 1): Promise<number> {
  const engine = new YdocLoopbackEngine();
  engine.seedFile({ workspace: "w", versionId: "v", path: "n.md", content: "" });
  const provider = await openEngineYdocProviderSession({
    transport: engine,
    workspace: "w",
    versionId: "v",
    path: "n.md",
    contentKind: "richdoc",
    onRemoteUpdate: () => undefined,
    scheduleSettle: () => () => undefined,
  });
  const editor = new Y.Doc();
  Y.applyUpdate(editor, provider.initialUpdate);
  const body = editor.getXmlFragment("body");
  const seeded = Y.encodeStateVector(editor);
  body.insert(
    0,
    Array.from({ length: paragraphs }, (_, index) => {
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText(`Paragraph ${index} keeps 😀 ordinary prose and `);
      for (let word = 0; word < words; word++)
        text.insert(text.length, `bold word ${word} 😀 `, { bold: word % 2 === 0 });
      paragraph.insert(0, [text]);
      return paragraph;
    }),
  );
  await provider.applyLocalUpdate(Y.encodeStateAsUpdate(editor, seeded), { armSettle: false });
  const target = (body.get(Math.floor(paragraphs / 2)) as Y.XmlElement).get(0) as Y.XmlText;
  const samples: number[] = [];
  for (let key = 0; key < KEYS + 5; key++) {
    const before = Y.encodeStateVector(editor);
    target.insert(target.length, "x");
    const update = Y.encodeStateAsUpdate(editor, before);
    const startedAt = performance.now();
    const recorded = provider.applyLocalUpdate(update, { armSettle: false });
    if (key >= 5) samples.push(performance.now() - startedAt);
    await recorded;
  }
  await provider.evict();
  return samples.sort((a, b) => a - b)[Math.floor(KEYS / 2)]!;
}

it("takes a typed character in a long note as fast as in a short one", async () => {
  const short = await keystrokeMedianMs(40);
  expect(await keystrokeMedianMs(4_000)).toBeLessThan(short * 4 + 0.5);
  expect(await keystrokeMedianMs(1, 20_000)).toBeLessThan(short * 4 + 0.5);
}, 60_000);
