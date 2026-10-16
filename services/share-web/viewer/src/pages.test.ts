import { fileURLToPath } from "node:url";
import { build, type Rolldown } from "vite";
import { expect, it } from "vitest";
import { VIEWER_PAGES } from "./pages";

const ROUTES = ["App.tsx", "NamedRecipientApp.tsx", "NamedChatApp.tsx", "NamedApp.tsx"];
const EDITOR = ["NamedDocumentEditor.tsx", "DiscardDraft.tsx"];

it("loads only each route's own code before it renders", async () => {
  const result = await build({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    logLevel: "silent",
    build: { write: false, emptyOutDir: false },
  });
  if (!("output" in result)) throw new Error("The viewer build returned no output.");
  const chunks = new Map(result.output
    .filter((item): item is Rolldown.OutputChunk => item.type === "chunk")
    .map(chunk => [chunk.fileName, chunk]));
  // A page loads its entry chunk and every chunk that chunk imports statically before it renders.
  const firstLoad = (page: string): string[] => {
    const entry = [...chunks.values()].find(chunk => chunk.isEntry && chunk.facadeModuleId?.replaceAll("\\", "/").endsWith(`/viewer/${page}`));
    if (!entry) throw new Error(`No entry chunk for ${page}.`);
    const seen = new Set<Rolldown.OutputChunk>();
    const visit = (chunk: Rolldown.OutputChunk) => {
      if (seen.has(chunk)) return;
      seen.add(chunk);
      for (const name of chunk.imports) visit(chunks.get(name)!);
    };
    visit(entry);
    return [...seen].flatMap(chunk => chunk.moduleIds.map(id => id.replaceAll("\\", "/")));
  };
  const loads = (modules: string[], names: string[]) => names.filter(name => modules.some(id => id.endsWith(`/viewer/src/${name}`)));
  const pages = Object.fromEntries(VIEWER_PAGES.map(page => [page, firstLoad(page)]));

  expect(Object.fromEntries(Object.entries(pages).map(([page, modules]) => [page, loads(modules, ROUTES)]))).toEqual({
    "index.html": ["App.tsx"],
    "edit.html": ["NamedRecipientApp.tsx"],
    "chat.html": ["NamedChatApp.tsx"],
    "apps.html": ["NamedApp.tsx"],
  });
  expect(loads(pages["chat.html"]!, EDITOR)).toEqual([]);
  expect(loads(pages["apps.html"]!, EDITOR)).toEqual([]);
});
