import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// privacy.html names every service the site talks to. A new host, cookie or
// beacon here means that page needs a matching change first.
const KNOWN_HOSTS = new Set([
  "api.github.com",
  "app.loops.so",
  "github.com",
  "docs.github.com",
  "loops.so",
  "www.cloudflare.com",
  "www.w3.org",
]);

const site = join(import.meta.dirname, "..");
const sources = [
  "index.html",
  "privacy.html",
  "site.js",
  "release-assets.ts",
  ...readdirSync(join(site, "src"))
    .filter((name) => /\.(ts|tsx|js)$/.test(name) && !/\.test\./.test(name))
    .map((name) => join("src", name)),
].map((path) => ({ path, text: readFileSync(join(site, path), "utf8") }));

it("talks only to the services the privacy page names", () => {
  const hosts = sources.flatMap(({ path, text }) =>
    [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => `${match[1]} (${path})`),
  );
  expect(hosts.filter((entry) => !KNOWN_HOSTS.has(entry.split(" ")[0]!))).toEqual([]);
});

it("sets no cookies and sends no beacons", () => {
  for (const { path, text } of sources) {
    expect(text, path).not.toMatch(/document\.cookie|sendBeacon|googletagmanager|gtag\(/);
  }
});
