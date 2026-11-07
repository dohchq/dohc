import {readFileSync} from "node:fs";
import {expect, it} from "vitest";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const defined = (block: string) => [...block.matchAll(/(--viewer-[a-z0-9-]+):/g)].map(match => match[1]).sort();

it("draws every viewer color from one token set with a dark value for each", () => {
  const styles = read("./styles.css");
  const light = /^:root \{([^}]*)\}/m.exec(styles)?.[1] ?? "";
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}\s*\}/.exec(styles)?.[1] ?? "";
  expect(light).toContain("color-scheme: light dark;");
  expect(defined(light).length).toBeGreaterThan(0);
  expect(defined(dark)).toEqual(defined(light));
  const rules = [styles.replace(light, "").replace(dark, ""), ...["./namedRecipient.css", "./namedChat.css", "./LinkEntry.css"].map(read)].join("\n");
  expect(rules.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi)).toBeNull();
  const used = new Set([...rules.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1]));
  for (const token of used) if (!token!.startsWith("--chat-")) expect(defined(light)).toContain(token);
  for (const page of ["index", "apps", "chat", "edit"]) expect(read(`../${page}.html`)).toContain('<meta name="color-scheme" content="light dark" />');
});
