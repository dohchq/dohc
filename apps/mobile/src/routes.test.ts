import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A link can open any route directly, so each route says which builds it serves (src/sampleOnly.tsx). The tabs, a chat
// and a page serve both builds: each shows sample data only in a sample build.
const ROOT = join(__dirname, "..");
const APP = join(ROOT, "app");
/** The test that a production build folds to false, written out where a sample module is required (src/sampleBuild.ts). */
const SAMPLE_TEST = '__DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1"';
const BOTH_BUILDS: Readonly<Record<string, string>> = {
  "(tabs)/(chats)/index.tsx": `export default ${SAMPLE_TEST} ?`,
  "(tabs)/notices/index.tsx": `export default ${SAMPLE_TEST} ?`,
  "(tabs)/home/index.tsx": "sampleBuild ?",
  "chat/[id].tsx": `export default ${SAMPLE_TEST} ?`,
  "page.tsx": `export default ${SAMPLE_TEST} ?`,
  // Search reads no data in either build yet.
  "(tabs)/search/index.tsx": "<NotYet",
};

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name))
    : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []);
}

const routes = () => files(APP).filter(path => !path.endsWith("_layout.tsx")).map(path => relative(APP, path));

describe("routes opened from a link", () => {
  it("each serve only the builds they're for", () => {
    const found = routes();
    expect(found.length).toBeGreaterThan(0);
    for (const route of found) {
      const source = readFileSync(join(APP, route), "utf8");
      const both = BOTH_BUILDS[route];
      if (both) {
        expect(source, route).toContain(both);
        continue;
      }
      expect(source, `${route} needs sampleOnly or signedInOnly`).toMatch(/^export default (sampleOnly|signedInOnly)\(/m);
    }
  });

  it("keep sample screens out of a signed-in build, and Settings out of a sample build", () => {
    const wrapped = (route: string) => readFileSync(join(APP, route), "utf8").match(/^export default (\w+)\(/m)?.[1];
    for (const route of ["(tabs)/(chats)/sharing.tsx", "agent-card.tsx", "checks.tsx"]) expect(wrapped(route), route).toBe("sampleOnly");
    for (const route of ["settings.tsx", "workspaces.tsx"]) expect(wrapped(route), route).toBe("signedInOnly");
  });
});

// Round 72 found the sample's data in the bundle of a build without it. Metro bundles every module a file imports, so
// only a require behind a test that folds to false keeps one out.
describe("sample modules", () => {
  const isSample = (path: string) => /(^|\/)sample\.ts$|(^|\/)Sample[A-Z]\w*\.tsx$/.test(path);
  const sources = [...files(APP), ...files(join(ROOT, "src"))].filter(path => !/\.test\.tsx?$/.test(path) && !path.endsWith("testServer.ts"));
  const target = (from: string, specifier: string) => {
    const base = resolve(dirname(from), specifier);
    return [base, `${base}.ts`, `${base}.tsx`].find(isSample);
  };

  it("exist where the rule names them", () => {
    expect(sources.filter(isSample).map(path => relative(ROOT, path)).sort()).toEqual([
      "src/chats/SampleAgentCard.tsx", "src/chats/SampleChats.tsx", "src/chats/sample.ts", "src/conversation/SampleConversation.tsx", "src/conversation/sample.ts",
      "src/notices/SampleNotices.tsx", "src/notices/sample.ts", "src/pages/SamplePage.tsx", "src/pages/sample.ts", "src/sharing/SampleSharing.tsx", "src/sharing/sample.ts",
      "src/testRoute/sample.ts",
    ]);
  });

  it("are imported elsewhere only as types, or required behind the sample test", () => {
    for (const path of sources.filter(path => !isSample(path))) {
      const source = readFileSync(path, "utf8");
      const name = relative(ROOT, path);
      for (const [, kind, specifier] of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)) {
        if (specifier && target(path, specifier)) expect(kind, `${name} imports ${specifier}`).toBe("type ");
      }
      for (const match of source.matchAll(/require\("([^"]+)"\)/g)) {
        const specifier = match[1]!;
        if (!target(path, specifier)) continue;
        const before = source.slice(0, match.index);
        expect(before.endsWith(`${SAMPLE_TEST} ? (`), `${name} requires ${specifier} without the sample test`).toBe(true);
      }
    }
  });
});
