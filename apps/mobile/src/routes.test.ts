import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// A link can open any route directly, so each route says which builds it serves (src/sampleOnly.tsx). The tabs serve
// both builds: each tab shows sample data only in a sample build.
const APP = join(__dirname, "..", "app");
const BOTH_BUILDS: Readonly<Record<string, string>> = {
  "(tabs)/(chats)/index.tsx": "sampleBuild ?",
  "(tabs)/notices/index.tsx": "sampleBuild ?",
  // Home and Search read no data in either build yet.
  "(tabs)/home/index.tsx": "<NotYet",
  "(tabs)/search/index.tsx": "<NotYet",
};

function routes(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? routes(join(directory, entry.name))
    : entry.name.endsWith(".tsx") && entry.name !== "_layout.tsx" ? [relative(APP, join(directory, entry.name))] : []);
}

describe("routes opened from a link", () => {
  it("each serve only the builds they're for", () => {
    const found = routes(APP);
    expect(found.length).toBeGreaterThan(0);
    for (const route of found) {
      const source = readFileSync(join(APP, route), "utf8");
      const both = BOTH_BUILDS[route];
      if (both) {
        expect(source, route).toContain(both);
        continue;
      }
      expect(source, `${route} needs sampleOnly or signedInOnly`).toMatch(/^export default (sampleOnly|signedInOnly)\(\w+\);$/m);
    }
  });

  it("keep sample screens out of a signed-in build, and Settings out of a sample build", () => {
    const wrapped = (route: string) => readFileSync(join(APP, route), "utf8").match(/^export default (\w+)\(/m)?.[1];
    for (const route of ["page.tsx", "chat/[id].tsx", "(tabs)/(chats)/sharing.tsx", "agent-card.tsx", "checks.tsx"]) {
      expect(wrapped(route), route).toBe("sampleOnly");
    }
    for (const route of ["settings.tsx", "workspaces.tsx"]) expect(wrapped(route), route).toBe("signedInOnly");
  });
});
