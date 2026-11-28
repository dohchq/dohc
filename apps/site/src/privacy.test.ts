import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// A guard on the site's own sources, not proof of privacy.html: it does not
// read the desktop code the demo imports, CSS, dependencies, or what a
// visitor puts in the demo. A new request destination, cookie, or beacon in
// these files means privacy.html needs a matching change first.
const KNOWN_HOSTS = new Set([
  "api.github.com",
  "app.loops.so",
  "github.com",
  "docs.github.com",
  "dohc.computer",
  "drive.dohc.computer",
  "loops.so",
  "posthog.com",
  "us.posthog.com",
  "us.i.posthog.com",
  "us-assets.i.posthog.com",
  "www.cloudflare.com",
  "www.w3.org",
]);

const site = join(import.meta.dirname, "..");
const sources = [
  "index.html",
  "privacy.html",
  "404.html",
  "site.js",
  "release-assets.ts",
  ...readdirSync(join(site, "src"))
    .filter((name) => /\.(ts|tsx|js)$/.test(name) && !/\.test\./.test(name))
    .map((name) => join("src", name)),
].map((path) => ({ path, text: readFileSync(join(site, path), "utf8") }));

it("names only disclosed hosts and the Discord redirect in the site's own sources", () => {
  const unexpectedHosts = sources.flatMap(({ path, text }) =>
    [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)]
      .filter((match) => {
        const isDiscordRedirect =
          path === join("src", "worker.ts") &&
          match[1] === "discord.gg" &&
          /\bheaders:\s*\{\s*location:\s*["']$/.test(text.slice(0, match.index));
        return !isDiscordRedirect && !KNOWN_HOSTS.has(match[1]!);
      })
      .map((match) => `${match[1]} (${path})`),
  );
  expect(unexpectedHosts).toEqual([]);
});

it("discloses each place the invite form sends an email address", () => {
  const index = sources.find(({ path }) => path === "index.html")!.text;
  const privacy = sources.find(({ path }) => path === "privacy.html")!.text;
  const form = index.match(/<form[^>]*data-waitlist[^>]*>/)![0];
  const destinations = [...form.matchAll(/(?:action|data-waitlist-copy)="https:\/\/([^/"]+)/g)].map(
    (match) => match[1],
  );
  expect(destinations).toEqual(["app.loops.so", "drive.dohc.computer"]);
  const invites = privacy.match(/<h2>Drive invite requests<\/h2>\s*<p>([\s\S]*?)<\/p>/)![1];
  expect(invites).toContain("Loops");
  expect(invites).toContain("drive.dohc.computer");
});

it("sets no cookies and sends no beacons from the site's own sources", () => {
  for (const { path, text } of sources) {
    expect(text, path).not.toMatch(/document\.cookie|sendBeacon|googletagmanager|gtag\(/);
  }
});
