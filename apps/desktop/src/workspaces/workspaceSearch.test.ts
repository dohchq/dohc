import { rgPath } from "@vscode/ripgrep";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildRipgrepArgs,
  createSearchRegistry,
  parseRipgrepLine,
  SEARCH_MAX_PREVIEW_CHARS,
  SEARCH_MAX_TOTAL_MATCHES,
  startRipgrepSearch,
  toSearchEntries,
  type SearchBatch,
  type SearchHandle,
} from "./workspaceSearch";

describe("buildRipgrepArgs", () => {
  it("pins the security-relevant base shape: json, exclusions, caps, -- terminator", () => {
    const args = buildRipgrepArgs({ query: "needle" });
    expect(args).toContain("--json");
    expect(args).toContain("--no-config");
    expect(args).toContain("--no-ignore-messages");
    // Defense-in-depth exclusions are ALWAYS present, at any nesting depth.
    for (const glob of ["!**/.dohc/**", "!**/.git/**", "!**/node_modules/**"]) {
      const at = args.indexOf(glob);
      expect(at, `${glob} present`).toBeGreaterThan(0);
      expect(args[at - 1]).toBe("-g");
    }
    expect(args.slice(args.indexOf("--max-filesize"))[1]).toBe("2M");
    expect(args.slice(args.indexOf("--max-count"))[1]).toBe("200");
    // The query is ALWAYS the single element after `--`: a query like
    // "--pre=/bin/sh" can never read as a flag.
    expect(args.slice(-2)).toEqual(["--", "needle"]);
  });

  it("keeps a flag-shaped query inert behind --", () => {
    const args = buildRipgrepArgs({ query: "--pre=/bin/evil" });
    expect(args.slice(-2)).toEqual(["--", "--pre=/bin/evil"]);
  });

  it("defaults to case-insensitive fixed-string search", () => {
    const args = buildRipgrepArgs({ query: "a.b" });
    expect(args).toContain("--ignore-case");
    expect(args).toContain("--fixed-strings");
    expect(args).not.toContain("--word-regexp");
  });

  it("maps the toggles: case, whole word, regex", () => {
    const args = buildRipgrepArgs({
      query: "a.b",
      caseSensitive: true,
      wholeWord: true,
      regex: true,
    });
    expect(args).toContain("--case-sensitive");
    expect(args).toContain("--word-regexp");
    expect(args).not.toContain("--fixed-strings");
    expect(args).not.toContain("--ignore-case");
  });

  it("appends the built-in exclusions AFTER user globs (last-match-wins keeps them authoritative)", () => {
    const args = buildRipgrepArgs({
      query: "x",
      includeGlob: "*.md",
      excludeGlob: "docs/**",
    });
    const include = args.indexOf("*.md");
    const exclude = args.indexOf("!docs/**");
    expect(args[include - 1]).toBe("-g");
    expect(args[exclude - 1]).toBe("-g");
    // rg glob precedence is last-match-wins: a user include glob placed
    // AFTER the built-ins would re-include .git/node_modules/.dohc content.
    // The built-ins must come last so they always win.
    for (const builtIn of ["!**/.dohc/**", "!**/.git/**", "!**/node_modules/**"]) {
      expect(args.indexOf(builtIn), `${builtIn} after user globs`).toBeGreaterThan(include);
      expect(args.indexOf(builtIn), `${builtIn} after user globs`).toBeGreaterThan(exclude);
    }
  });
});

function matchEvent(overrides: {
  path?: string;
  lineText?: string;
  lineNumber?: number;
  submatches?: Array<{ start: number; end: number }>;
}): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: overrides.path ?? "notes/a.md" },
      lines: { text: overrides.lineText ?? "hello needle world\n" },
      line_number: overrides.lineNumber ?? 3,
      absolute_offset: 0,
      submatches: (overrides.submatches ?? [{ start: 6, end: 12 }]).map((s) => ({
        match: { text: "x" },
        ...s,
      })),
    },
  });
}

describe("parseRipgrepLine", () => {
  it("returns data for match events only", () => {
    expect(parseRipgrepLine(matchEvent({}))).not.toBeNull();
    expect(parseRipgrepLine(JSON.stringify({ type: "begin", data: {} }))).toBeNull();
    expect(parseRipgrepLine(JSON.stringify({ type: "summary", data: {} }))).toBeNull();
    expect(parseRipgrepLine("not json")).toBeNull();
    expect(parseRipgrepLine("")).toBeNull();
    expect(parseRipgrepLine("null")).toBeNull();
  });
});

describe("toSearchEntries", () => {
  it("emits one entry per submatch with 1-based line/column and the trimmed line", () => {
    const data = parseRipgrepLine(
      matchEvent({
        lineText: "one needle two needle\n",
        submatches: [
          { start: 4, end: 10 },
          { start: 15, end: 21 },
        ],
      }),
    );
    const entries = toSearchEntries(data!);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      path: "notes/a.md",
      line: 3,
      column: 5,
      preview: "one needle two needle",
      matchStart: 4,
      matchEnd: 10,
    });
    expect(entries[1].matchStart).toBe(15);
    expect(entries[1].column).toBe(16);
  });

  it("windows long lines around the match and re-bases offsets into the preview", () => {
    const long = `${"x".repeat(500)}NEEDLE${"y".repeat(500)}`;
    const data = parseRipgrepLine(
      matchEvent({ lineText: `${long}\n`, submatches: [{ start: 500, end: 506 }] }),
    );
    const [entry] = toSearchEntries(data!);
    expect(entry.preview.length).toBe(SEARCH_MAX_PREVIEW_CHARS);
    expect(entry.preview.slice(entry.matchStart, entry.matchEnd)).toBe("NEEDLE");
    // The full-line column survives windowing.
    expect(entry.column).toBe(501);
  });

  it("converts rg's byte offsets to character offsets for multi-byte lines", () => {
    // "héllo needle" — é is 2 bytes in UTF-8, so rg reports byte start 7.
    const data = parseRipgrepLine(
      matchEvent({ lineText: "héllo needle\n", submatches: [{ start: 7, end: 13 }] }),
    );
    const [entry] = toSearchEntries(data!);
    expect(entry.preview.slice(entry.matchStart, entry.matchEnd)).toBe("needle");
    expect(entry.column).toBe(7); // char offset 6 → 1-based 7
  });

  it("refuses traversal/absolute/reserved paths (validateUserWritePath rule)", () => {
    for (const path of ["../outside.md", "/etc/passwd", ".dohc/cred.json", "a\\..\\b"]) {
      const data = parseRipgrepLine(matchEvent({ path }));
      expect(toSearchEntries(data!), path).toEqual([]);
    }
  });

  it("refuses ignored-segment paths at any depth — the backstop when rg globs are out-voted", () => {
    // validateUserWritePath rejects these today; this test also pins the
    // search-layer backstop in case rg include globs surface ignored paths.
    for (const path of [
      ".git/config",
      "sub/.git/HEAD",
      "node_modules/pkg/index.js",
      "deep/node_modules/x/y.js",
    ]) {
      const data = parseRipgrepLine(matchEvent({ path }));
      expect(toSearchEntries(data!), path).toEqual([]);
    }
  });

  it("skips malformed events: missing text, bad offsets, bad line numbers", () => {
    expect(toSearchEntries({})).toEqual([]);
    expect(
      toSearchEntries({
        path: { text: "a.md" },
        lines: {},
        line_number: 1,
        submatches: [{ start: 0, end: 1 }],
      }),
    ).toEqual([]);
    const negative = parseRipgrepLine(matchEvent({ submatches: [{ start: -1, end: 2 }] }));
    expect(toSearchEntries(negative!)).toEqual([]);
    const inverted = parseRipgrepLine(matchEvent({ submatches: [{ start: 5, end: 2 }] }));
    expect(toSearchEntries(inverted!)).toEqual([]);
    const badLine = parseRipgrepLine(matchEvent({ lineNumber: 0 }));
    expect(toSearchEntries(badLine!)).toEqual([]);
  });
});

// Real-binary integration: @vscode/ripgrep's rgPath must resolve and run on
// this platform, and the streamed batches must respect exclusions and caps.
describe("startRipgrepSearch (real rg)", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "dohc-search-"));
    roots.push(root);
    return root;
  }

  function runSearch(
    root: string,
    request: Parameters<typeof buildRipgrepArgs>[0],
  ): Promise<SearchBatch[]> {
    return new Promise((resolve) => {
      const batches: SearchBatch[] = [];
      startRipgrepSearch({
        rgPath,
        realRoot: root,
        searchId: "test-1",
        request,
        onBatch: (batch) => {
          batches.push(batch);
          if (batch.done) resolve(batches);
        },
      });
    });
  }

  it("finds matches, excludes .dohc/.git/node_modules content, ignores symlinks", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".dohc"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "real.md"), "alpha sentinelvalue omega\n");
    await writeFile(join(root, ".hidden.md"), "dotfile sentinelvalue\n");
    await writeFile(join(root, ".dohc", "planted.md"), "sentinelvalue inside dohc\n");
    await writeFile(join(root, ".git", "planted.md"), "sentinelvalue inside git\n");
    await writeFile(join(root, "node_modules", "pkg", "planted.js"), "sentinelvalue\n");
    const outside = await mkdtemp(join(tmpdir(), "dohc-search-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.md"), "sentinelvalue outside\n");
    await symlink(outside, join(root, "escape"));

    const batches = await runSearch(root, { query: "sentinelvalue" });
    const entries = batches.flatMap((b) => b.entries);
    const paths = entries.map((e) => e.path).sort();
    // The real file AND the dotfile (explorer parity), never the reserved
    // dirs or anything through the symlink.
    expect(paths).toEqual([".hidden.md", "notes/real.md"]);
    expect(batches.at(-1)).toMatchObject({ done: true, limitHit: false });
    const real = entries.find((e) => e.path === "notes/real.md")!;
    expect(real.line).toBe(1);
    expect(real.preview.slice(real.matchStart, real.matchEnd)).toBe("sentinelvalue");
  });

  // Regression (codex E5.0 review, P1): rg glob precedence is last-match-
  // wins, so with the built-in exclusions placed BEFORE the user include
  // glob, includeGlob '**/.git/**' — and even benign filters '*', '**/*',
  // 'config' — surfaced planted .git/node_modules content (e.g. credential
  // tokens in .git/config remote URLs). Both layers are pinned here: the
  // built-ins now come last in the argv AND toSearchEntries drops ignored
  // segments regardless of argv shape.
  it("include globs can never re-include .git/.dohc/node_modules content", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".dohc"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "config"), "plantedsecret in a real file named config\n");
    await writeFile(join(root, "real.md"), "plantedsecret in markdown\n");
    await writeFile(join(root, ".git", "config"), "url = https://x:plantedsecret@host/r.git\n");
    await writeFile(join(root, ".dohc", "state.json"), '{"token":"plantedsecret"}\n');
    await writeFile(join(root, "node_modules", "pkg", "i.js"), "// plantedsecret\n");

    for (const includeGlob of ["**/.git/**", "*", "**/*", "config", undefined]) {
      const batches = await runSearch(root, { query: "plantedsecret", includeGlob });
      const paths = batches.flatMap((b) => b.entries).map((e) => e.path);
      expect(
        paths.filter((p) => /(^|\/)(\.git|\.dohc|node_modules)(\/|$)/.test(p)),
        `includeGlob=${String(includeGlob)} must not surface reserved segments`,
      ).toEqual([]);
    }
    // Benign filters still work: '*.md' narrows to the markdown file, a user
    // exclude still excludes, and 'config' finds the REAL file named config.
    const md = await runSearch(root, { query: "plantedsecret", includeGlob: "*.md" });
    expect(md.flatMap((b) => b.entries).map((e) => e.path)).toEqual(["real.md"]);
    const named = await runSearch(root, { query: "plantedsecret", includeGlob: "config" });
    expect(named.flatMap((b) => b.entries).map((e) => e.path)).toEqual(["config"]);
    const excluded = await runSearch(root, {
      query: "plantedsecret",
      excludeGlob: "*.md",
    });
    expect(excluded.flatMap((b) => b.entries).map((e) => e.path)).toEqual(["config"]);
  });

  it("respects case/word/regex toggles end to end", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "t.md"), "Case CASE case\nword words sword\nfoo1 foo2\n");
    const insensitive = await runSearch(root, { query: "CASE" });
    expect(insensitive.flatMap((b) => b.entries)).toHaveLength(3);
    const sensitive = await runSearch(root, { query: "CASE", caseSensitive: true });
    expect(sensitive.flatMap((b) => b.entries)).toHaveLength(1);
    const whole = await runSearch(root, { query: "word", wholeWord: true });
    expect(whole.flatMap((b) => b.entries)).toHaveLength(1);
    const literal = await runSearch(root, { query: "foo\\d" });
    expect(literal.flatMap((b) => b.entries)).toHaveLength(0);
    const regex = await runSearch(root, { query: "foo\\d", regex: true });
    expect(regex.flatMap((b) => b.entries)).toHaveLength(2);
  });

  it("stops at the total-match cap, kills the child, and flags limitHit", async () => {
    const root = await makeRoot();
    // 15 files x 300 matching lines; per-file cap 200 → 3000 candidates,
    // stream cap stops at 2000.
    const body = Array.from({ length: 300 }, (_, i) => `line ${i} capmatch`).join("\n");
    await Promise.all(
      Array.from({ length: 15 }, (_, i) => writeFile(join(root, `cap-${i}.md`), body)),
    );
    const batches = await runSearch(root, { query: "capmatch" });
    const total = batches.reduce((sum, b) => sum + b.entries.length, 0);
    expect(total).toBe(SEARCH_MAX_TOTAL_MATCHES);
    expect(batches.at(-1)!.limitHit).toBe(true);
    expect(batches.at(-1)!.done).toBe(true);
  });

  it("streams results in bounded batches (entries cap per batch)", async () => {
    const root = await makeRoot();
    const body = Array.from({ length: 120 }, (_, i) => `row ${i} streamtok`).join("\n");
    await writeFile(join(root, "stream.md"), body);
    const batches = await runSearch(root, { query: "streamtok" });
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.entries.length).toBeLessThanOrEqual(50);
    }
  });

  // Regression: ONE rg match event carries one entry per SUBMATCH, and a
  // long prose line against a short query carries hundreds. The batch cap
  // must hold per batch regardless (an oversized batch fails the IPC
  // contract parse — this once wedged the app mid-keystroke).
  it("keeps batches bounded even when a single line yields hundreds of submatches", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "dense.md"), `${"x ".repeat(300)}\n`);
    const batches = await runSearch(root, { query: "x" });
    const total = batches.reduce((sum, b) => sum + b.entries.length, 0);
    expect(total).toBe(300);
    for (const batch of batches) {
      expect(batch.entries.length).toBeLessThanOrEqual(50);
    }
  });
});

describe("createSearchRegistry", () => {
  function fakeStart(killed: string[]) {
    return (options: { searchId: string; onBatch: (b: SearchBatch) => void }): SearchHandle => ({
      searchId: options.searchId,
      kill: () => killed.push(options.searchId),
    });
  }

  it("kills the previous search when an owner starts a new one", async () => {
    const killed: string[] = [];
    const registry = createSearchRegistry({ rgPath: "/unused", start: fakeStart(killed) as never });
    const root = await mkdtemp(join(tmpdir(), "dohc-reg-"));
    await registry.startSearch(1, root, "s1", { query: "a" }, () => {});
    await registry.startSearch(1, root, "s2", { query: "b" }, () => {});
    expect(killed).toEqual(["s1"]);
    await rm(root, { recursive: true, force: true });
  });

  it("cancel kills only a matching searchId; disposeOwner and killAll kill tracked children", async () => {
    const killed: string[] = [];
    const registry = createSearchRegistry({ rgPath: "/unused", start: fakeStart(killed) as never });
    const root = await mkdtemp(join(tmpdir(), "dohc-reg-"));
    await registry.startSearch(1, root, "s1", { query: "a" }, () => {});
    registry.cancel(1, "wrong-id");
    expect(killed).toEqual([]);
    registry.cancel(1, "s1");
    expect(killed).toEqual(["s1"]);
    await registry.startSearch(2, root, "s3", { query: "c" }, () => {});
    registry.disposeOwner(2);
    expect(killed).toEqual(["s1", "s3"]);
    await registry.startSearch(3, root, "s4", { query: "d" }, () => {});
    registry.killAll();
    expect(killed).toEqual(["s1", "s3", "s4"]);
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a root that does not resolve", async () => {
    const registry = createSearchRegistry({ rgPath: "/unused", start: fakeStart([]) as never });
    await expect(
      registry.startSearch(1, "/definitely/not/a/real/root", "s1", { query: "a" }, () => {}),
    ).rejects.toThrow();
  });
});
