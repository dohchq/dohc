// Real TypeScript oracle for `effectivePolicy.ts`: the policy glob subset, the
// `.dohc/*.toml` rule parsers, and the effective-policy resolver that
// `crates/dohc-engine-files/src/search_policy.rs` ports.
//
// Regenerate with:
//   node crates/dohc-engine-files/tests/fixtures/gen-fixtures.mjs
//   DOHC_FIXTURE_OUT=<directory> node crates/dohc-engine-files/tests/fixtures/gen-fixtures.mjs
//
// The oracle is TypeScript, so this registers tsx itself rather than requiring
// the caller to run it under `tsx` — the same shape the dohc-engine-collab and
// dohc-engine-sync generators use, so the fixture drift check runs all three
// with plain node.
//
// ## Which floor inputs this fixture may use
//
// `resolveEffectivePolicy` starts from the path floor, and `search_policy.rs`
// carries TWO deliberate, documented deltas from the TypeScript floor:
//   - the Windows host-unsafe write admission checks (ADS colon, device
//     basenames, 8.3 aliases) are not re-litigated there, and
//   - reserved/secret segment comparison is per-platform (`BEHAVIOR_DELTA.md`
//     CAL-3), so a trailing-dot/space or case-variant alias such as
//     `config/secret.env. ` classifies differently on Windows and POSIX.
// Resolution vectors therefore stay inside the platform-independent shared
// subset. The floor's own cross-platform parity is asserted by the
// `dohc-engine-sync` security-contract fixture against `policy.rs`. This set
// also emits focused write-floor vectors for the files crate's differential
// test. Both fixtures call the live classifier and declare no verdicts by hand.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");
const outputDir = process.env.DOHC_FIXTURE_OUT
  ? resolve(process.env.DOHC_FIXTURE_OUT)
  : here;
mkdirSync(outputDir, { recursive: true });

// tsx lives in the pnpm virtual store of the working checkout, with an override
// for an unusual layout. There is deliberately no shared-checkout fallback: the
// oracle imports `smol-toml`, whose link pnpm writes to
// `packages/security-contract/node_modules/`, so a checkout without its own
// install cannot run this generator no matter where tsx is found.
const require = createRequire(join(repoRoot, "package.json"));
const tsxBases = [
  process.env.DOHC_TSX_BASE,
  repoRoot,
  join(repoRoot, "node_modules/.pnpm"),
].filter(Boolean);
let tsxApiPath = null;
for (const base of tsxBases) {
  try {
    tsxApiPath = require.resolve("tsx/esm/api", { paths: [base] });
    break;
  } catch {
    /* try next base */
  }
}
if (!tsxApiPath) {
  throw new Error(
    `could not resolve tsx/esm/api from any base:\n${tsxBases.join("\n")}\nrun 'pnpm install --offline --frozen-lockfile' or set DOHC_TSX_BASE before regenerating effective-policy fixtures`,
  );
}
const { register } = await import(pathToFileURL(tsxApiPath).href);
const unregisterTsx = register();
const {
  parseFilesPolicy,
  parseVisibilityPolicy,
  policyGlobMatches,
  resolveEffectivePolicy,
  validatePolicyGlob,
} = await import(
  pathToFileURL(
    join(repoRoot, "packages/security-contract/src/effectivePolicy.ts"),
  ).href
);
const { classifyEngineFilePath } = await import(
  pathToFileURL(
    join(repoRoot, "packages/security-contract/src/enginePathFloor.ts"),
  ).href
);
await unregisterTsx();

// --------------------------------------------------------- glob validation
// One vector per rejection branch of `validatePolicyGlob`, plus the accepted
// shapes the matcher vectors below rely on. The pairs that could trip two
// branches at once (`/bad?`, `!bad[`) pin the branch ORDER, which decides which
// reason a user's agent reads back.
const globValidationPatterns = [
  "",
  "/rooted/x.md",
  "!private/**",
  "dir\\file.md",
  "bad?",
  "bad[abc]",
  "bad]",
  "bad{a,b}",
  "bad}",
  "dir//file.md",
  "dir/",
  "../outside",
  "a/../b",
  "a/**/b",
  "**/a.md",
  "foo**",
  "a/**b",
  "a*b*c",
  "a/b*c*d.md",
  "/bad?",
  "!bad[",
  "**",
  "*",
  "*.md",
  "notes/*.md",
  "notes/**",
  "a/b/c.md",
  "./notes/a.md",
  ".dohc/**",
  "ab*b",
  "café*.md",
  "A*.MD",
];

// ------------------------------------------------------------ glob matching
// `*` vs `**`, segment boundaries, case, leading `./`, trailing `/`, an empty
// path, a star that must match zero characters, and the overlapping
// prefix/suffix edge where a naive prefix+suffix test would accept a path too
// short to contain both.
const globMatchPairs = [
  ["**", "a/b"],
  ["**", ""],
  ["**", ".dohc/files.toml"],
  ["**", "a"],
  ["dir/**", "dir/a"],
  ["dir/**", "dir/a/b"],
  ["dir/**", "dir"],
  ["dir/**", "dir/"],
  ["dir/**", "dir/a/"],
  ["dir/**", "dirx/a"],
  ["dir/**", ""],
  ["*/**", "a/b/c"],
  ["*", "a.md"],
  ["*", "a/b"],
  ["*", ""],
  ["*.md", "notes.md"],
  ["*.md", "a/notes.md"],
  ["*.md", ".md"],
  ["*.md", "md"],
  ["notes/*.md", "notes/a.md"],
  ["notes/*.md", "notes/sub/a.md"],
  ["notes/*.md", "notes/.md"],
  ["notes/*.md", "notes"],
  ["notes/today.md", "notes/today.md"],
  ["notes/today.md", "notes/other.md"],
  ["notes/today.md", "notes/today.md/x"],
  ["notes/*.MD", "notes/a.md"],
  ["NOTES/a.md", "notes/a.md"],
  ["./notes/a.md", "notes/a.md"],
  ["./notes/a.md", "./notes/a.md"],
  ["a/b/c.md", "a/b/c.md/"],
  ["ab*b", "ab"],
  ["ab*b", "abb"],
  ["ab*b", "abxb"],
  ["café*é", "café"],
  ["café*é", "caféxé"],
  ["café*.md", "café.md"],
  ["café*.md", "caf.md"],
];

// ------------------------------------------------------------- TOML parsing
// Cases are named so a failing differential test points at a branch, not an
// index. Every branch of `parseFilesPolicy` / `parseVisibilityPolicy` appears:
// TOML syntax failure, top-level key shape, rule-array shape, per-entry shape,
// unknown keys, path validation, value-type validation, and the
// no-partial-application rule.
const filesPolicyCases = [
  ["valid-multi-rule", '[[rule]]\npath = "drafts/**"\ntracked = false\nsearchable = false\n\n[[rule]]\npath = "docs/*.md"\nsearchable = true\n'],
  ["valid-inline-array", 'rule = [{ path = "a.md", tracked = true }]\n'],
  ["valid-empty-rule-array", "rule = []\n"],
  ["valid-path-only", '[[rule]]\npath = "**"\n'],
  ["empty-document", ""],
  ["only-unknown-top-level-key", "foo = 1\n"],
  ["unknown-top-level-key-with-rules", 'version = true\n[[rule]]\npath = "x.md"\n'],
  ["unknown-top-level-keys-integer-like", "zeta = 1\n2 = 2\n1 = 3\n"],
  ["rule-not-array", 'rule = "not-array"\n'],
  ["rule-is-table", '[rule]\npath = "x.md"\n'],
  ["rule-entry-not-table", "rule = [1]\n"],
  ["rule-entry-array", "rule = [[1]]\n"],
  ["missing-path", "[[rule]]\ntracked = false\n"],
  ["empty-path", '[[rule]]\npath = ""\n'],
  ["non-string-path", "[[rule]]\npath = 1\n"],
  ["unknown-rule-key", '[[rule]]\npath = "x.md"\nmode = true\n'],
  ["unknown-rule-keys-out-of-order", '[[rule]]\npath = "x.md"\nzeta = 1\nalpha = 2\n'],
  // TOML allows bare integer keys, and the oracle reports one error per key in
  // `Object.keys` order: JavaScript enumerates ARRAY INDEX keys first, ascending
  // numerically, then every other key in insertion order. A key that does not
  // round-trip through `ToString(ToUint32)` (`01`, `+1`) is an ordinary string
  // key, and so is `4294967295`, one past the last index.
  ["unknown-rule-keys-integer-like", '[[rule]]\npath = "x.md"\nzeta = 1\n2 = 2\n1 = 3\n'],
  ["unknown-rule-keys-non-canonical-integers", '[[rule]]\npath = "x.md"\n"01" = 1\n"+1" = 2\n1 = 3\n'],
  ["unknown-rule-keys-array-index-boundary", '[[rule]]\npath = "x.md"\n4294967295 = 1\n4294967294 = 2\n0 = 3\n'],
  // The boundary case above cannot SEE the `4294967295` exclusion: `path` is
  // the only non-index key there, and it reports no error, so moving
  // `4294967295` between the index half and the named half leaves the reported
  // error order unchanged. An unknown NAMED key ahead of the boundary key is
  // what makes the two halves distinguishable: `zeta` is reported BEFORE
  // `4294967295` only while `4294967295` is an ordinary string key.
  ["unknown-rule-keys-named-before-array-index-boundary", '[[rule]]\npath = "x.md"\nzeta = 1\n4294967295 = 2\n0 = 3\n'],
  ["tracked-not-boolean", '[[rule]]\npath = "x.md"\ntracked = "false"\n'],
  ["searchable-not-boolean", '[[rule]]\npath = "x.md"\nsearchable = 1\n'],
  ["invalid-path-glob", '[[rule]]\npath = "bad/**/x.md"\ntracked = false\n'],
  ["second-rule-invalid-rejects-all", '[[rule]]\npath = "ok.md"\ntracked = false\n[[rule]]\npath = "bad["\n'],
  ["toml-syntax-error", '[[rule]\npath = "x.md"\n'],
  ["toml-duplicate-key", '[[rule]]\npath = "a.md"\npath = "b.md"\n'],
  ["toml-duplicate-table", "[table]\nx = 1\n\n[table]\ny = 2\n"],
];

const visibilityPolicyCases = [
  ["valid-multi-rule", '[[rule]]\npath = "private/**"\nvisibility = "hidden"\nexport = "redacted"\n\n[[rule]]\npath = "docs/*.md"\nvisibility = "visible"\n'],
  ["valid-export-only", '[[rule]]\npath = "a.md"\nexport = "excluded"\n'],
  ["valid-included-export", '[[rule]]\npath = "a.md"\nexport = "included"\n'],
  ["valid-empty-rule-array", "rule = []\n"],
  ["empty-document", ""],
  ["unknown-top-level-key-with-rules", 'other = true\n[[rule]]\npath = "x.md"\n'],
  ["rule-not-array", 'rule = "not-array"\n'],
  ["rule-entry-not-table", 'rule = ["x"]\n'],
  ["missing-path", '[[rule]]\nexport = "included"\n'],
  ["unknown-rule-key", '[[rule]]\npath = "x.md"\ntracked = true\n'],
  ["unknown-rule-keys-integer-like", '[[rule]]\npath = "x.md"\nzeta = 1\n2 = 2\n1 = 3\n'],
  ["visibility-not-string", "[[rule]]\npath = \"x.md\"\nvisibility = true\n"],
  ["visibility-unknown-value", '[[rule]]\npath = "x.md"\nvisibility = "public"\n'],
  ["export-unknown-value", '[[rule]]\npath = "x.md"\nexport = "public"\n'],
  ["export-not-string", "[[rule]]\npath = \"x.md\"\nexport = 1\n"],
  ["invalid-path-glob", '[[rule]]\npath = "../x.md"\nvisibility = "hidden"\n'],
  ["second-rule-invalid-rejects-all", '[[rule]]\npath = "ok.md"\nvisibility = "hidden"\n[[rule]]\npath = "bad?"\n'],
  ["toml-syntax-error", 'visibility = "hidden\n'],
];

// -------------------------------------------------------- policy resolution
// Floor short-circuit (each floor kind), the no-policy default, rule order,
// per-field last-match-wins, non-matching rules, and the escalation denial that
// keeps a permissive rule from lifting a secret or ignored path.
const blanketFiles = [
  { path: "**", tracked: true, searchable: true },
  { path: "docs/**", searchable: false },
  { path: "docs/private.md", tracked: false },
];
const blanketVisibility = [
  { path: "**", visibility: "visible", export: "included" },
  { path: "docs/**", visibility: "hidden", export: "redacted" },
];

const resolutionCases = [
  ["no-policy-tracked-default", "notes/public.md", null, null],
  ["no-policy-secret-floor", ".env", null, null],
  ["no-policy-ignored-floor", ".dohc/files.toml", null, null],
  ["empty-policy-arrays", "notes/public.md", [], []],
  ["secret-floor-denies-escalation", "config/.env", blanketFiles, blanketVisibility],
  ["ignored-floor-denies-escalation", ".dohc/files.toml", blanketFiles, blanketVisibility],
  ["ignored-floor-node-modules", "node_modules/pkg/index.js", blanketFiles, blanketVisibility],
  ["ignored-floor-git", "notes/.git/config", blanketFiles, blanketVisibility],
  ["ignored-floor-shared-with-me", "shared-with-me/alex/brief.md", blanketFiles, blanketVisibility],
  ["ignored-floor-write-temp", "nested/.dohc-write-temp", blanketFiles, blanketVisibility],
  ["ignored-floor-traversal", "a/../b.md", blanketFiles, blanketVisibility],
  ["ignored-floor-absolute", "C:/absolute.md", blanketFiles, blanketVisibility],
  ["secret-floor-percent-encoded", "encoded/secrets%2eenv", blanketFiles, blanketVisibility],
  ["blanket-then-directory-rule", "docs/guide.md", blanketFiles, blanketVisibility],
  ["blanket-then-file-rule", "docs/private.md", blanketFiles, blanketVisibility],
  ["unmatched-path-keeps-defaults", "notes/plan.md", blanketFiles, blanketVisibility],
  [
    "later-rule-wins-per-set-field-only",
    "docs/a.md",
    [
      { path: "docs/**", tracked: false, searchable: false },
      { path: "docs/a.md", tracked: true },
    ],
    [
      { path: "docs/**", visibility: "hidden", export: "redacted" },
      { path: "docs/a.md", export: "included" },
    ],
  ],
  [
    "tracked-false-does-not-force-searchable-false",
    "docs/a.md",
    [{ path: "docs/**", tracked: false, searchable: true }],
    null,
  ],
  [
    "non-matching-rules-are-skipped",
    "notes/a.md",
    [{ path: "docs/**", tracked: false, searchable: false }],
    [{ path: "docs/**", visibility: "hidden", export: "excluded" }],
  ],
  [
    "visibility-rules-do-not-touch-files-fields",
    "notes/a.md",
    null,
    [{ path: "notes/*.md", visibility: "hidden", export: "redacted" }],
  ],
  [
    "files-rules-do-not-touch-visibility-fields",
    "notes/a.md",
    [{ path: "notes/*.md", tracked: false, searchable: false }],
    null,
  ],
  [
    "star-rule-matches-dotfile-name",
    "config/.keep",
    [{ path: "config/*", searchable: false }],
    null,
  ],
];

// ------------------------------------------------------------ path floor
// Unlike `search_policy.rs`, `policy.rs::classify_engine_file_path` applies
// case folding and Win32 alias stripping on every platform. These write-floor
// vectors therefore have the same verdict on Windows and POSIX.
const pathFloorInputs = [
  "notes/today.md",
  ".env",
  "secrets/.env/nested.md",
  "deploy/prod.env",
  "config/.env.local",
  "deploy/PROD.ENV",
  "config/.ENV.LOCAL",
  "secret.env ",
  "config/.env.local. ",
  "secrets%252eenv",
  ".dohc/engine/engine.db",
  "notes/DOHC~1/x.md",
  "../escape.md",
  ".envrc",
  "notes/envelope.md",
  "notes/env/config.md",
];

const fixture = {
  globValidation: globValidationPatterns.map((pattern) => {
    const result = validatePolicyGlob(pattern);
    return result.ok
      ? { pattern, ok: true }
      : { pattern, ok: false, reason: result.reason };
  }),
  globMatches: globMatchPairs.map(([pattern, path]) => ({
    pattern,
    path,
    matches: policyGlobMatches(pattern, path),
  })),
  filesPolicy: filesPolicyCases.map(([name, toml]) =>
    parseCase(name, toml, parseFilesPolicy),
  ),
  visibilityPolicy: visibilityPolicyCases.map(([name, toml]) =>
    parseCase(name, toml, parseVisibilityPolicy),
  ),
  resolution: resolutionCases.map(([name, path, filesPolicy, visibilityPolicy]) => ({
    name,
    path,
    filesPolicy,
    visibilityPolicy,
    result: resolveEffectivePolicy({ path, filesPolicy, visibilityPolicy }),
  })),
};

const pathFloorFixture = pathFloorInputs.map((path) => ({
  path,
  classification: classifyEngineFilePath(path).kind,
}));

// smol-toml and the Rust `toml` crate word their syntax errors differently, so
// a case that fails inside the TOML PARSER can only assert the failure and the
// `invalid TOML: ` prefix the two ports share. Derived from the oracle's own
// output rather than declared by hand, so a case that stops failing in the
// parser stops being excused.
function parseCase(name, toml, parse) {
  const result = parse(toml);
  if (result.ok) return { name, toml, ok: true, rules: result.rules };
  const parserMessage =
    result.errors.length === 1 && result.errors[0].startsWith("invalid TOML: ");
  return {
    name,
    toml,
    ok: false,
    ...(parserMessage ? { parserMessage: true } : {}),
    errors: result.errors,
  };
}

writeFileSync(
  join(outputDir, "effective-policy.json"),
  `${JSON.stringify(fixture, null, 2)}\n`,
);
writeFileSync(
  join(outputDir, "path-floor.json"),
  `${JSON.stringify(pathFloorFixture, null, 2)}\n`,
);
