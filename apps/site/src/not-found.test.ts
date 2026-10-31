import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import config from "../vite.config";

const site = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(site, path), "utf8");

it("serves 404.html with a 404 status for unknown paths", () => {
  const wrangler = JSON.parse(read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, ""));
  expect(wrangler.assets.not_found_handling).toBe("404-page");
  expect(config.build?.rolldownOptions?.input).toContain("404.html");
});

// Cloudflare serves the page at any depth, such as /a/b/c, so a relative
// path would miss.
it("loads the 404 page's files from absolute paths", () => {
  const paths = [...read("404.html").matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]!);
  expect(paths.filter((path) => !/^(\/|https:\/\/|#)/.test(path))).toEqual([]);
  expect(paths).toContain("/");
});
