import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// A guard on the site's own sources, not proof of privacy.html: it does not
// read the desktop code the demo imports, CSS, dependencies, or what a
// visitor puts in the demo. A new host, cookie or beacon in these files means
// privacy.html needs a matching change first.
const KNOWN_HOSTS = new Set([
  "api.github.com",
  "app.loops.so",
  "github.com",
  "docs.github.com",
  "dohc.computer",
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

it("names only hosts the privacy page covers in the site's own sources", () => {
  const hosts = sources.flatMap(({ path, text }) =>
    [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => `${match[1]} (${path})`),
  );
  expect(hosts.filter((entry) => !KNOWN_HOSTS.has(entry.split(" ")[0]!))).toEqual([]);
});

it("sets no cookies and sends no beacons from the site's own sources", () => {
  for (const { path, text } of sources) {
    expect(text, path).not.toMatch(/document\.cookie|sendBeacon|googletagmanager|gtag\(/);
  }
});
