// Live TypeScript oracle for the Collection contracts. Regenerate with:
//   node crates/dohc-engine-domain/tests/fixtures/gen-fixtures.mjs
//   DOHC_FIXTURE_OUT=<directory> node crates/dohc-engine-domain/tests/fixtures/gen-fixtures.mjs
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");
const outputDir = process.env.DOHC_FIXTURE_OUT
  ? resolve(process.env.DOHC_FIXTURE_OUT)
  : here;
mkdirSync(outputDir, { recursive: true });

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
    // Try the next workspace-local base.
  }
}
if (!tsxApiPath) {
  throw new Error(
    `could not resolve tsx/esm/api from any base:\n${tsxBases.join("\n")}\nrun 'pnpm install --offline --frozen-lockfile' or set DOHC_TSX_BASE before regenerating collection-contract fixtures`,
  );
}

const { register } = await import(pathToFileURL(tsxApiPath).href);
const unregisterTsx = register();
const { isRecordId, parseCollectionSchema, validateFieldValue } = await import(
  pathToFileURL(
    join(repoRoot, "packages/workspace-contracts/src/collectionValues.ts"),
  ).href
);
const { COLLECTION_SCHEMA_REASON_CODES, FIELD_VALUE_REASON_CODES } = await import(
  pathToFileURL(join(repoRoot, "packages/workspace-contracts/src/collection.ts")).href
);
const { getDohcYDocFrontmatter, markdownToYDoc } = await import(
  pathToFileURL(
    join(repoRoot, "packages/ydoc-projection/src/import-export.ts"),
  ).href
);
await unregisterTsx();

const workspaceContractsRequire = createRequire(
  join(repoRoot, "packages/workspace-contracts/package.json"),
);
const { CORE_SCHEMA, load } = workspaceContractsRequire("js-yaml");

const schemas = [
  {
    name: "normalized-field-name-collision-flags-and-keeps-both",
    yaml: 'fields:\n  true:\n    type: text\n  "true":\n    type: number\n',
  },
  {
    name: "valid-all-v1-types-and-views",
    yaml: `name: Projects
description: Work in flight
fields:
  title:
    type: text
  estimate:
    type: number
  done:
    type: checkbox
  due:
    type: date
  status:
    type: select
    options: [Planned, Active, Done]
  labels:
    type: multi-select
    options: [Backend, Frontend]
  owner:
    type: person
  parent:
    type: relation
    collection: planning/projects
    many: false
  dependencies:
    type: relation
    collection: planning/projects
    many: true
  website:
    type: url
views:
  - name: All projects
    kind: table
    sort:
      - field: due
        direction: asc
    visibleFields: [title, status, owner, due]
  - name: Status board
    kind: board
    groupBy: status
    visibleFields: [title, owner]
  - name: Delivery calendar
    kind: calendar
    dateField: due
`,
  },
  { name: "valid-empty-schema", yaml: "" },
  {
    name: "degraded-bad-yaml",
    yaml: "fields:\n  title: [\n",
  },
  {
    name: "degraded-unknown-field-type-salvages-siblings",
    yaml: `fields:
  title:
    type: text
  score:
    type: formula
views:
  - name: Table
    kind: table
    visibleFields: [title, score]
`,
  },
  {
    name: "degraded-bad-relation-target-salvages-siblings",
    yaml: `fields:
  title:
    type: text
  project:
    type: relation
    collection: ../projects
    many: false
`,
  },
  {
    name: "degraded-c1-relation-target-salvages-siblings",
    yaml: `fields:
  title:
    type: text
  project:
    type: relation
    collection: "planning\u0085projects"
    many: false
`,
    expected: {
      status: "degraded",
      schema: {
        name: null,
        description: null,
        fields: [{ name: "title", type: "text" }],
        views: [],
      },
      reasons: [
        {
          code: "invalid-relation-target",
          path: "/fields/project/collection",
        },
      ],
    },
  },
  {
    name: "degraded-shapes-return-structured-reasons",
    yaml: `name: 42
extra: ignored
fields:
  id:
    type: text
  status:
    type: select
    options: [Active, Active, 3]
  relation:
    type: relation
    collection: teams/people
    many: yes
views:
  - name: Broken references
    kind: board
    groupBy: missing
    sort:
      - field: status
        direction: sideways
    visibleFields: [status, missing, status]
`,
  },
  {
    name: "invalid-view-kind-does-not-reserve-view-name",
    yaml: `fields:
  title:
    type: text
views:
  - name: Primary
    kind: timeline
  - name: Primary
    kind: table
    visibleFields: [title]
`,
  },
];

const relationSingle = {
  name: "project",
  type: "relation",
  collection: "planning/projects",
  many: false,
};
const relationMany = { ...relationSingle, name: "projects", many: true };
const fieldValues = [
  ["text-valid", { name: "title", type: "text" }, "hello"],
  ["text-flagged", { name: "title", type: "text" }, "42"],
  ["number-valid", { name: "estimate", type: "number" }, "42.5"],
  ["number-flagged-type", { name: "estimate", type: "number" }, '"42"'],
  ["number-flagged-non-finite", { name: "estimate", type: "number" }, ".nan"],
  ["checkbox-valid", { name: "done", type: "checkbox" }, "true"],
  ["checkbox-flagged", { name: "done", type: "checkbox" }, '"true"'],
  ["date-valid", { name: "due", type: "date" }, "2024-02-29"],
  ["date-flagged", { name: "due", type: "date" }, "2023-02-29"],
  [
    "select-valid",
    { name: "status", type: "select", options: ["Planned", "Active"] },
    "Active",
  ],
  [
    "select-flagged",
    { name: "status", type: "select", options: ["Planned", "Active"] },
    "Done",
  ],
  [
    "multi-select-valid",
    { name: "labels", type: "multi-select", options: ["A", "B"] },
    "[A, B]",
  ],
  [
    "multi-select-flagged-option",
    { name: "labels", type: "multi-select", options: ["A", "B"] },
    "[A, C]",
  ],
  [
    "multi-select-flagged-duplicate",
    { name: "labels", type: "multi-select", options: ["A", "B"] },
    "[A, A]",
  ],
  ["person-valid", { name: "owner", type: "person" }, "user_123"],
  ["person-flagged", { name: "owner", type: "person" }, '"   "'],
  [
    "relation-single-valid",
    relationSingle,
    "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  ],
  ["relation-single-flagged", relationSingle, "record_123"],
  [
    "relation-many-valid",
    relationMany,
    "[rec_aaaaaaaaaaaaaaaaaaaaaaaaaa, rec_77777777777777777777777774]",
  ],
  [
    "relation-many-flagged-entry",
    relationMany,
    "[rec_aaaaaaaaaaaaaaaaaaaaaaaaaa, REC_77777777777777777777777774]",
  ],
  [
    "relation-many-flagged-duplicate",
    relationMany,
    "[rec_aaaaaaaaaaaaaaaaaaaaaaaaaa, rec_aaaaaaaaaaaaaaaaaaaaaaaaaa]",
  ],
  ["url-valid", { name: "website", type: "url" }, "https://dohc.dev/path"],
  ["url-flagged", { name: "website", type: "url" }, "dohc.dev/path"],
  ["null-valid-for-every-field", { name: "title", type: "text" }, "null"],
].map(([name, field, valueYaml]) => {
  const value = load(valueYaml, { schema: CORE_SCHEMA, json: true });
  return { name, field, valueYaml, expected: validateFieldValue(field, value) };
});

const recordIds = [
  "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rec_77777777777777777777777774",
  "rec_abcdefghijklmnopqrstuvwxyz",
  "rec_aaaaaaaaaaaaaaaaaaaaaaaaa",
  "rec_aaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "REC_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rec_Aaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rec_00000000000000000000000000",
  "rec_11111111111111111111111111",
  "rec_88888888888888888888888888",
  "rec_aaaaaaaaaaaaaaaaaaaaaaaaa=",
  "record_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rec_😀😀😀😀😀😀😀😀😀😀😀😀😀",
].map((value) => ({ value, valid: isRecordId(value) }));

const frontmatter = [
  {
    name: "space-opener-tab-closer",
    markdown: "--- \ntitle: Space opener\n---\t\nBody",
  },
  {
    name: "tab-opener-space-closer",
    markdown: "---\t\ntitle: Tab opener\n--- \nBody",
  },
  {
    name: "closing-delimiter-at-eof-with-newline",
    markdown: "---\ntitle: EOF newline\n---\n",
  },
  {
    name: "closing-delimiter-at-eof-without-newline",
    markdown: "---\ntitle: EOF no newline\n---",
  },
  {
    name: "closing-delimiter-at-eof-without-newline-and-trailing-whitespace",
    markdown: "---\ntitle: EOF trailing whitespace\n--- \t",
  },
  {
    name: "empty-frontmatter-is-empty-map",
    markdown: "---\n---",
  },
  {
    name: "comment-only-frontmatter-is-empty-map",
    markdown: "---\n# note\n---",
  },
  {
    name: "unsafe-integer-is-exact",
    markdown: "---\nexact: 9007199254740993\n---",
  },
  {
    name: "separated-unsafe-integer-is-exact",
    markdown: "---\nexact: 1_000_000_000_000_000_003\n---",
  },
  {
    name: "quoted-separated-integer-stays-text",
    markdown: '---\nexact: "1_000_000_000_000_000_003"\n---',
  },
  {
    name: "unsupported-explicit-tag-keeps-raw-value",
    markdown: "---\npriority: !custom high\n---\n\n# Body",
  },
].map(({ name, markdown }) => ({
  name,
  markdown,
  expected: getDohcYDocFrontmatter(markdownToYDoc(markdown)),
}));

function writeFixture(name, value) {
  const json = JSON.stringify(
    value,
    (_key, child) =>
      typeof child === "bigint" ? { $dohcInt64: child.toString() } : child,
    2,
  ).replaceAll("\u0085", "\\u0085");
  writeFileSync(join(outputDir, name), `${json}\n`);
}

writeFixture("collection-schemas.json", {
  vectors: schemas.map(({ name, yaml, expected }) => {
    const parsed = parseCollectionSchema(yaml);
    if (expected !== undefined && !isDeepStrictEqual(expected, parsed)) {
      throw new Error(`schema fixture ${name} disagrees with parseCollectionSchema`);
    }
    return { name, yaml, expected: expected ?? parsed };
  }),
});
writeFixture("collection-field-values.json", { vectors: fieldValues });
writeFixture("collection-record-ids.json", { vectors: recordIds });
writeFixture("collection-frontmatter.json", { vectors: frontmatter });
writeFixture("collection-reason-codes.json", {
  schemaReasonCodes: COLLECTION_SCHEMA_REASON_CODES,
  fieldValueReasonCodes: FIELD_VALUE_REASON_CODES,
});
