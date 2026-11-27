import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { GUIDES } from "./guides";

const skillFolder = new URL("../../../skills/dohc/", import.meta.url);

it("bundles skills/dohc as the guide resources; run vitest -u after editing a guide", async () => {
  const entries = Object.entries(GUIDES) as [
    keyof typeof GUIDES,
    (typeof GUIDES)[keyof typeof GUIDES],
  ][];
  const bundled: Record<string, string> = {};
  for (const [name, { source }] of entries) {
    let markdown = await readFile(new URL(source, skillFolder), "utf8");
    for (const [linked, guide] of entries)
      markdown = markdown.replaceAll(`](${guide.source})`, `](dohc://guides/${linked})`);
    bundled[name] = markdown.replaceAll("\r\n", "\n");
  }
  expect(Object.values(bundled).join("")).not.toContain("](references/");
  await expect(`${JSON.stringify(bundled, null, 2)}\n`).toMatchFileSnapshot("./guides.main.json");
});
