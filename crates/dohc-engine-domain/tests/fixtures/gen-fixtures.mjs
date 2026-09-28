// Live TypeScript oracle for the Collection contracts. Regenerate with:
//   node crates/dohc-engine-domain/tests/fixtures/gen-fixtures.mjs
//   DOHC_FIXTURE_OUT=<directory> node crates/dohc-engine-domain/tests/fixtures/gen-fixtures.mjs
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
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
const { encodeCollectionValue } = await import(
  pathToFileURL(
    join(
      repoRoot,
      "packages/workspace-engine-client/src/workspace/workspaceWireContract.ts",
    ),
  ).href
);
await unregisterTsx();

const workspaceContractsRequire = createRequire(
  join(repoRoot, "packages/workspace-contracts/package.json"),
);
const { CORE_SCHEMA, load } = workspaceContractsRequire("js-yaml");

const schemas = [
  ...[1, 2, 0, -1, 1.5, null, true, "1"].map(version => ({
    name: `schema-version-${JSON.stringify(version)}`,
    yaml: `version: ${JSON.stringify(version)}\nname: Tasks\nfields:\n  Done:\n    type: checkbox\n`,
  })),
  { name: "schema-version-float-current", yaml: "version: 1.0\nname: Tasks\n" },
  { name: "schema-version-float-newer", yaml: "version: 2.0\nname: Tasks\n" },
  {
    name: "valid-comment-only-schema",
    yaml: "# collection schema to be filled in later\n",
    expected: {
      status: "valid",
      schema: { name: null, description: null, fields: [], views: [] },
      reasons: [],
    },
  },
  {
    name: "scalar-root-is-rejected",
    yaml: "collection\n",
  },
  {
    name: "sequence-root-is-rejected",
    yaml: "- collection\n",
  },
  {
    name: "multi-document-input-is-rejected",
    yaml: "---\nfields: {}\n---\nfields: {}\n",
  },
  {
    name: "non-text-root-key-is-unknown-property",
    yaml: "? [unexpected, key]\n: ignored\n",
    expected: {
      status: "degraded",
      schema: { name: null, description: null, fields: [], views: [] },
      reasons: [{ code: "unknown-property", path: "/<non-text-key>" }],
    },
  },
  {
    name: "non-text-field-property-is-unknown-property",
    yaml: "fields:\n  title:\n    type: text\n    ? [unexpected, key]\n    : ignored\n",
    expected: {
      status: "degraded",
      schema: {
        name: null,
        description: null,
        fields: [{ name: "title", type: "text" }],
        views: [],
      },
      reasons: [{ code: "unknown-property", path: "/fields/title/<non-text-key>" }],
    },
  },
  {
    name: "normalized-field-name-collision-flags-and-keeps-both",
    yaml: 'fields:\n  true:\n    type: text\n  "true":\n    type: number\n',
  },
  {
    name: "unquoted-floating-point-field-name-is-text",
    yaml: "fields:\n  1.5:\n    type: text\n",
  },
  {
    name: "integral-float-key-at-1e21-normalizes-without-exponent",
    yaml: "fields:\n  1e21:\n    type: text\n",
    expected: {
      status: "valid",
      schema: {
        name: null,
        description: null,
        fields: [{ name: "1000000000000000000000", type: "text" }],
        views: [],
      },
      reasons: [],
    },
  },
  {
    name: "small-fraction-key-normalizes-without-exponent",
    yaml: "fields:\n  0.0000001:\n    type: text\n",
    expected: {
      status: "valid",
      schema: {
        name: null,
        description: null,
        fields: [{ name: "0.0000001", type: "text" }],
        views: [],
      },
      reasons: [],
    },
  },
  {
    name: "non-finite-keys-use-rust-f64-spellings",
    yaml: "fields:\n  .inf:\n    type: text\n  -.inf:\n    type: number\n  .nan:\n    type: checkbox\n",
    expected: {
      status: "valid",
      schema: {
        name: null,
        description: null,
        fields: [
          { name: "inf", type: "text" },
          { name: "-inf", type: "number" },
          { name: "NaN", type: "checkbox" },
        ],
        views: [],
      },
      reasons: [],
    },
  },
  {
    name: "numeric-key-spellings-normalize-to-one-text-and-collide",
    yaml: 'fields:\n  1e21:\n    type: text\n  "1000000000000000000000":\n    type: number\n',
    expected: {
      status: "degraded",
      schema: {
        name: null,
        description: null,
        fields: [
          { name: "1000000000000000000000", type: "text" },
          { name: "1000000000000000000000", type: "number" },
        ],
        views: [],
      },
      reasons: [
        { code: "field-name-collision", path: "/fields/1000000000000000000000" },
        { code: "field-name-collision", path: "/fields/1000000000000000000000" },
      ],
    },
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
  {
    name: "duplicate-and-escaped-schema-properties-use-last-resolved-key",
    yaml: `fields:
  title:
    type: number
    "ty\\u0070e": text
  status:
    type: select
    options: [Old]
    "optio\\u006es": [New]
  owner:
    type: relation
    collection: old/people
    "collectio\\u006e": people
    many: true
    "ma\\u006ey": false
  due:
    type: date
views:
  - name: Old
    "na\\u006de": All
    kind: board
    "ki\\u006ed": table
    groupBy: status
    "groupB\\u0079": title
    sort:
      - field: status
        direction: desc
    "so\\u0072t":
      - field: status
        "fie\\u006cd": title
        direction: desc
        "directio\\u006e": asc
    visibleFields: [status]
    "visibleField\\u0073": [title]
    dateField: due
    "dateFiel\\u0064": title
`,
  },
  {
    name: "duplicate-escaped-unknown-schema-properties-report-once",
    yaml: `fields:
  title:
    type: text
    mystery: first
    "myste\\u0072y": second
views:
  - name: All
    kind: table
    extra: first
    "ext\\u0072a": second
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
  ...["C:/projects", "C:projects", "planning/projects:stream"].map((collection, index) => ({
    name: `degraded-colon-relation-target-${index + 1}-salvages-siblings`,
    yaml: `fields:
  title:
    type: text
  project:
    type: relation
    collection: "${collection}"
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
      reasons: [{ code: "invalid-relation-target", path: "/fields/project/collection" }],
    },
  })),
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
  {
    name: "duplicate-view-name-suppresses-inner-reasons",
    yaml: `fields:
  title:
    type: text
views:
  - name: Primary
    kind: table
  - name: Primary
    kind: calendar
    groupBy: missing
    sort: invalid
    visibleFields: invalid
    dateField: missing
`,
  },
  {
    name: "button-field-is-visible-but-never-sorts-groups-or-dates",
    yaml: `fields:
  title:
    type: text
  Mark paid:
    type: button
views:
  - name: All
    kind: table
    visibleFields: [title, Mark paid]
  - name: By button
    kind: calendar
    groupBy: Mark paid
    sort:
      - field: Mark paid
        direction: asc
      - field: title
        direction: desc
    dateField: Mark paid
`,
    expected: {
      status: "degraded",
      schema: {
        name: null,
        description: null,
        fields: [
          { name: "title", type: "text" },
          { name: "Mark paid", type: "button" },
        ],
        views: [
          {
            name: "All",
            kind: "table",
            groupBy: null,
            sort: [],
            visibleFields: ["title", "Mark paid"],
            dateField: null,
          },
          {
            name: "By button",
            kind: "calendar",
            groupBy: null,
            sort: [{ field: "title", direction: "desc" }],
            visibleFields: null,
            dateField: null,
          },
        ],
      },
      reasons: [
        { code: "unsupported-field-reference", path: "/views/1/groupBy" },
        { code: "unsupported-field-reference", path: "/views/1/sort/0/field" },
        { code: "unsupported-field-reference", path: "/views/1/dateField" },
      ],
    },
  },
  {
    name: "button-field-takes-no-other-properties",
    yaml: `fields:
  Mark paid:
    type: button
    options: [Paid]
`,
    expected: {
      status: "degraded",
      schema: {
        name: null,
        description: null,
        fields: [{ name: "Mark paid", type: "button" }],
        views: [],
      },
      reasons: [{ code: "unknown-property", path: "/fields/Mark paid/options" }],
    },
  },
  {
    name: "view-sort-one-over-query-limit-flags-and-keeps-first-eight",
    yaml: `fields:
  title:
    type: text
views:
  - name: All
    kind: table
    sort:
      - field: title
        direction: asc
      - field: title
        direction: desc
      - field: title
        direction: asc
      - field: title
        direction: desc
      - field: title
        direction: asc
      - field: title
        direction: desc
      - field: title
        direction: asc
      - field: title
        direction: desc
      - field: title
        direction: asc
`,
    expected: {
      status: "degraded",
      schema: {
        name: null,
        description: null,
        fields: [{ name: "title", type: "text" }],
        views: [
          {
            name: "All",
            kind: "table",
            groupBy: null,
            sort: [
              { field: "title", direction: "asc" },
              { field: "title", direction: "desc" },
              { field: "title", direction: "asc" },
              { field: "title", direction: "desc" },
              { field: "title", direction: "asc" },
              { field: "title", direction: "desc" },
              { field: "title", direction: "asc" },
              { field: "title", direction: "desc" },
            ],
            visibleFields: null,
            dateField: null,
          },
        ],
      },
      reasons: [
        {
          code: "schema-collection-limit-exceeded",
          path: "/views/0/sort",
        },
      ],
    },
  },
];

const relationSingle = {
  name: "project",
  type: "relation",
  collection: "planning/projects",
  many: false,
};
const relationMany = { ...relationSingle, name: "projects", many: true };
function loadFixtureYamlValue(valueYaml) {
  const loadedValue = load(valueYaml, { schema: CORE_SCHEMA, json: true });
  return /^-?\d+$/.test(valueYaml) &&
    typeof loadedValue === "number" &&
    !Number.isSafeInteger(loadedValue)
    ? BigInt(valueYaml)
    : loadedValue;
}

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
  ["button-null-valid", { name: "Mark paid", type: "button" }, "null"],
  ["button-flagged", { name: "Mark paid", type: "button" }, "true"],
  ["button-flagged-empty-text", { name: "Mark paid", type: "button" }, '""'],
].map(([name, field, valueYaml]) => {
  const value = loadFixtureYamlValue(valueYaml);
  return { name, field, valueYaml, expected: validateFieldValue(field, value) };
});

const pipelineTargetA = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const pipelineTargetB = "rec_77777777777777777777777774";
let markerDepthBoundaryYaml = "true";
for (let depth = 1; depth < 24; depth += 1) {
  markerDepthBoundaryYaml = `{ $dohcInt64: ${markerDepthBoundaryYaml} }`;
}
const pipelineValues = [
  ["text-typical", "typical", { type: "text" }, '"café 🙂"'],
  ["text-edge", "edge", { type: "text" }, '""'],
  ["text-flagged", "flagged", { type: "text" }, "42"],
  ["number-typical", "typical", { type: "number" }, "42.5"],
  ["number-edge", "edge", { type: "number" }, "9007199254740993"],
  ["number-flagged", "flagged", { type: "number" }, '"42"'],
  ["checkbox-typical", "typical", { type: "checkbox" }, "true"],
  ["checkbox-edge", "edge", { type: "checkbox" }, "false"],
  ["checkbox-flagged", "flagged", { type: "checkbox" }, '"true"'],
  ["date-typical", "typical", { type: "date" }, '"2026-08-30"'],
  ["date-edge", "edge", { type: "date" }, '"2000-02-29"'],
  ["date-flagged", "flagged", { type: "date" }, '"2023-02-29"'],
  [
    "select-typical",
    "typical",
    { type: "select", options: ["Planned", "Active", "true"] },
    "Active",
  ],
  [
    "select-edge",
    "edge",
    { type: "select", options: ["Planned", "Active", "true"] },
    '"true"',
  ],
  [
    "select-flagged",
    "flagged",
    { type: "select", options: ["Planned", "Active", "true"] },
    "Done",
  ],
  [
    "multi-select-typical",
    "typical",
    { type: "multi-select", options: ["A", "B"] },
    "[A, B]",
  ],
  [
    "multi-select-edge",
    "edge",
    { type: "multi-select", options: ["A", "B"] },
    "[]",
  ],
  [
    "multi-select-flagged",
    "flagged",
    { type: "multi-select", options: ["A", "B"] },
    "[A, A]",
  ],
  ["person-typical", "typical", { type: "person" }, "user_123"],
  ["person-edge", "edge", { type: "person" }, '"  user_123  "'],
  ["person-flagged", "flagged", { type: "person" }, '"   "'],
  [
    "relation-typical",
    "typical",
    { type: "relation", collection: "pipeline-targets", many: false },
    pipelineTargetA,
  ],
  [
    "relation-edge",
    "edge",
    { type: "relation", collection: "pipeline-targets", many: true },
    `[${pipelineTargetA}, ${pipelineTargetB}]`,
  ],
  [
    "relation-flagged",
    "flagged",
    { type: "relation", collection: "pipeline-targets", many: false },
    "record_123",
  ],
  [
    "url-typical",
    "typical",
    { type: "url" },
    '"https://dohc.dev/path?x=1#frag"',
  ],
  ["url-edge", "edge", { type: "url" }, '"mailto:user@example.com"'],
  ["url-flagged", "flagged", { type: "url" }, '"dohc.dev/path"'],
  [
    "text-marker-depth-boundary",
    "edge",
    { type: "text" },
    markerDepthBoundaryYaml,
  ],
].map(([name, valueClass, definition, valueYaml]) => {
  const fieldName = name.replaceAll("-", "_");
  const field = { name: fieldName, ...definition };
  const value = loadFixtureYamlValue(valueYaml);
  const wireValue = encodeCollectionValue(value);
  return {
    name,
    class: valueClass,
    fieldName,
    field,
    valueYaml,
    valueYamlUtf8Hex: Buffer.from(valueYaml, "utf8").toString("hex"),
    expectedSemantic: value,
    expectedIndexJson: indexJson(value),
    expectedValidation: validateFieldValue(field, value),
    expectedWireValue: wireValue,
    expectedWireJson: JSON.stringify(wireValue),
  };
});

function indexJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(indexJson).join(",")}]`;
  return JSON.stringify(value);
}

function pipelineSchemaYaml(vectors) {
  const lines = ["name: Field pipeline", "fields:"];
  for (const vector of vectors) {
    const { field } = vector;
    lines.push(`  ${field.name}:`, `    type: ${field.type}`);
    if ("options" in field) {
      lines.push(`    options: ${JSON.stringify(field.options)}`);
    }
    if (field.type === "relation") {
      lines.push(
        `    collection: ${field.collection}`,
        `    many: ${field.many}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function pipelineRecordMarkdown(vectors) {
  const lines = ["---"];
  for (const vector of vectors) {
    lines.push(`${vector.fieldName}: ${vector.valueYaml}`);
  }
  lines.push("---", "", "Pipeline record");
  return lines.join("\n");
}

function plainFixtureValue(value) {
  if (Array.isArray(value)) return value.map(plainFixtureValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, plainFixtureValue(child)]),
    );
  }
  return value;
}

const pipelineRecord = pipelineRecordMarkdown(pipelineValues);
const pipelineFrontmatter = getDohcYDocFrontmatter(
  markdownToYDoc(pipelineRecord),
);
for (const vector of pipelineValues) {
  if (
    !isDeepStrictEqual(
      plainFixtureValue(pipelineFrontmatter[vector.fieldName]),
      plainFixtureValue(vector.expectedSemantic),
    )
  ) {
    throw new Error(`pipeline fixture ${vector.name} disagrees with markdownToYDoc`);
  }
}

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
    name: "unsafe-integer-nesting-is-exact",
    markdown: [
      "---",
      "exact: 9007199254740993",
      "nested:",
      "  exact: 9007199254740993",
      "sequence:",
      "  - 9007199254740993",
      "---",
    ].join("\n"),
  },
  {
    name: "constructor-map-and-unsafe-integer-share-array",
    markdown: [
      "---",
      "sequence:",
      "  - constructor: hostile-constructor",
      "  - 9007199254740993",
      "---",
    ].join("\n"),
  },
  {
    name: "literal-shared-bigint-key-map-survives-the-shared-branch",
    markdown: [
      "---",
      "sequence:",
      "  - constructor: hostile-constructor",
      "  - $dohcBigInt: 9007199254740993",
      "---",
    ].join("\n"),
  },
  {
    name: "integral-float-outside-int64-remains-a-number",
    markdown: "---\nexact: 1e20\n---",
  },
  {
    name: "separated-unsafe-integer-is-exact",
    markdown: "---\nexact: 1_000_000_000_000_000_003\n---",
  },
  {
    name: "separated-hex-integer-is-exact",
    markdown: "---\nexact: 0x20_0000_0000_0001\n---",
  },
  {
    name: "separated-octal-integer-is-exact",
    markdown: "---\nexact: 0o400_0000_0000_0000_0001\n---",
  },
  {
    name: "trailing-integer-separator-stays-text",
    markdown: "---\nexact: 1_\n---",
    expected: { exact: "1_" },
  },
  {
    name: "consecutive-integer-separators-stay-text",
    markdown: "---\nexact: 1__2\n---",
    expected: { exact: "1__2" },
  },
  {
    name: "hex-prefix-integer-separator-stays-text",
    markdown: "---\nexact: 0x_FF\n---",
    expected: { exact: "0x_FF" },
  },
  {
    name: "octal-trailing-integer-separator-stays-text",
    markdown: "---\nexact: 0o17_\n---",
    expected: { exact: "0o17_" },
  },
  {
    name: "quoted-separated-integer-stays-text",
    markdown: '---\nexact: "1_000_000_000_000_000_003"\n---',
  },
  {
    name: "unsupported-explicit-tag-keeps-raw-value",
    markdown: "---\npriority: !custom high\n---\n\n# Body",
  },
  // What each loader reads where YAML and the value model disagree. A value
  // the model cannot hold keeps its text; a block the desktop's js-yaml
  // loader refuses is refused by the engine too.
  {
    name: "non-finite-floats-keep-their-text",
    markdown: "---\nnan: .nan\nnamed: .NaN\ninf: .inf\nneg: -.Inf\nplus: +.inf\n---",
  },
  {
    name: "integers-outside-int64-keep-their-text",
    markdown:
      "---\nbig: 9223372036854775808\nsmall: -9223372036854775809\nhuge: 99999999999999999999\nmax: 9223372036854775807\n---",
  },
  {
    name: "negative-zero-integer-is-zero",
    markdown: "---\nzero: -0\n---",
  },
  {
    name: "explicit-core-tags-resolve-like-plain-scalars",
    markdown:
      '---\ntagged: !!int 7\noctal: !!int 0o7\nbinary: !!int 0b101\nsigned: !!int -0x1F\nquoted: !!int "12"\nfloat: !!float 1.5\ntext: !!str 7\n---',
  },
  {
    name: "verbatim-core-tags-resolve-like-shorthand-tags",
    markdown:
      "---\nint: !<tag:yaml.org,2002:int> 7\ntext: !<tag:yaml.org,2002:str> 7\nlist: !<tag:yaml.org,2002:seq> [a]\n---",
  },
  {
    name: "explicit-tags-that-cannot-resolve-keep-their-text",
    markdown: "---\nflag: !!bool yes\ncount: !!int many\nnothing: !!null nope\n---",
  },
  {
    name: "binary-and-signed-radix-integers-stay-text",
    markdown: "---\nbin: 0b1010_1010\nplain: 0b101\nsigned: -0x1F\nhex: 0x_1F\nseparated: 0x1_F\n---",
  },
  {
    name: "custom-tagged-scalars-keep-their-text",
    markdown: "---\ncount: !custom 7\nflag: !custom true\n---",
  },
  {
    name: "kept-block-scalar-keeps-its-last-blank-line",
    markdown: "---\nb: |+\n  keeps\n\n---",
  },
  {
    name: "number-keys-read-as-javascript-spells-them",
    markdown: "---\n1e21: a\n1e-7: b\n-0.0: c\n1.0: d\n1.5: e\n.nan: f\n---",
  },
  {
    name: "alias-keys-and-values-expand",
    markdown: "---\nlist: &list [1, 2]\ncopy: *list\nname: &name key\n*name : value\n---",
  },
  {
    name: "quoted-value-continued-past-its-sequence-reads",
    markdown: '---\na:\n- "x\n y"\n---',
  },
  {
    name: "quoted-value-continued-at-its-sequence-column-is-rejected",
    markdown: '---\na:\n- "x\ny"\n---',
    expected: null,
  },
  {
    name: "quoted-value-continued-at-its-mapping-column-is-rejected",
    markdown: '---\na:\n  b: "x\n  y"\n---',
    expected: null,
  },
  {
    name: "collection-key-is-rejected",
    markdown: "---\n? [a, b]\n: 1\n---",
    expected: null,
  },
  {
    name: "nested-collection-key-is-rejected",
    markdown: "---\nouter:\n  ? {a: 1}\n  : 1\n---",
    expected: null,
  },
  {
    name: "collection-key-under-a-custom-tag-is-rejected",
    markdown: "---\nx: !custom\n  ? [a]\n  : 1\n---",
    expected: null,
  },
  {
    name: "alias-to-an-unknown-anchor-is-rejected",
    markdown: "---\na: *x\n---",
    expected: null,
  },
  {
    name: "alias-inside-its-own-anchor-is-rejected",
    markdown: "---\na: &x [*x]\n---",
    expected: null,
  },
  {
    name: "second-document-is-rejected",
    markdown: "---\na: 1\n...\nb: 2\n---",
    expected: null,
  },
  {
    name: "flow-nesting-past-the-depth-limit-is-rejected",
    markdown: `---\nvalue: ${"[".repeat(130)}x${"]".repeat(130)}\n---`,
    expected: null,
  },
  {
    name: "block-nesting-past-the-depth-limit-is-rejected",
    markdown: `---\nvalue:\n${Array.from({ length: 130 }, (_, index) => `${"  ".repeat(index + 1)}-`).join("\n")} x\n---`,
    expected: null,
  },
  {
    name: "aliases-at-the-alias-limit-read",
    markdown: `---\nx: &x 1\nlist: [${Array(256).fill("*x").join(", ")}]\n---`,
  },
  {
    name: "aliases-past-the-alias-limit-are-rejected",
    markdown: `---\nx: &x 1\nlist: [${Array(257).fill("*x").join(", ")}]\n---`,
    expected: null,
  },
  {
    name: "alias-ladder-past-the-node-budget-is-rejected",
    markdown: `---\n${Array.from({ length: 6 }, (_, level) => `l${level}: &l${level} [${
      Array(10).fill(level === 0 ? "x" : `*l${level - 1}`).join(", ")
    }]`).join("\n")}\n---`,
    expected: null,
  },
  {
    name: "separated-floats-stay-text",
    markdown: "---\na: 1_0.5\nb: 1_000.5\nc: !!float 1_0.5\n---",
  },
  {
    name: "scalars-tagged-as-collections-keep-their-text",
    markdown: "---\nseq: !!seq x\nmap: !!map x\nempty: !!seq\n---",
  },
  {
    name: "yaml-directive-without-a-document-start-is-rejected",
    markdown: "---\n%YAML 1.2\na: 1\n---",
    expected: null,
  },
  {
    name: "tag-directive-is-rejected",
    markdown: "---\n%TAG !e! tag:example.com,2026:\na: !e!x 1\n---",
    expected: null,
  },
  {
    name: "second-document-start-inside-the-block-is-rejected",
    markdown: "---\n--- # x\na: 1\n---",
    expected: null,
  },
  {
    name: "carriage-return-inside-a-line-is-rejected",
    markdown: '---\na: "x\ry"\n---',
    expected: null,
  },
  {
    name: "closing-delimiter-with-a-bare-carriage-return-does-not-close",
    markdown: "---\na: 1\n---\r",
    expected: null,
  },
  {
    name: "opening-delimiter-with-two-carriage-returns-does-not-open",
    markdown: "---\r\r\na: 1\n---",
  },
  {
    name: "empty-key-reads-as-null",
    markdown: "---\n: note\ntitle: A\n---",
  },
  {
    name: "nested-anchors-read",
    markdown: "---\ns: &s x\nv: &a [&b [*s, *s], *b]\n---",
  },
  {
    name: "aliases-past-the-string-byte-budget-are-rejected",
    markdown: `---\ns: &s "${"x".repeat(1024)}"\nl1: &l1 [${Array(100).fill("*s").join(", ")}]\nl2: &l2 [${Array(100).fill("*l1").join(", ")}]\nl3: [*l2, *l2]\n---`,
    expected: null,
  },
  {
    name: "duplicate-floating-point-key-is-rejected",
    markdown:
      "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n1.5: first\n1.5: second\n---",
    expected: null,
  },
  {
    name: "duplicate-id-frontmatter-is-rejected",
    markdown: "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nid: rec_77777777777777777777777774\n---",
    expected: null,
  },
  {
    name: "duplicate-escaped-id-before-literal-is-rejected",
    markdown: '---\n"\\u0069d": rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nid: rec_77777777777777777777777774\n---',
    expected: null,
  },
  {
    name: "duplicate-literal-id-before-escaped-is-rejected",
    markdown: '---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n"\\u0069d": rec_77777777777777777777777774\n---',
    expected: null,
  },
  {
    name: "duplicate-two-escaped-id-forms-are-rejected",
    markdown: '---\n"\\u0069d": rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n"\\x69d": rec_77777777777777777777777774\n---',
    expected: null,
  },
  {
    name: "duplicate-escaped-record-property-is-rejected",
    markdown: '---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\ntitle: First\n"ti\\u0074le": Second\n---',
    expected: null,
  },
  {
    name: "duplicate-escaped-nested-record-property-is-rejected",
    markdown: '---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nmetadata:\n  title: First\n  "ti\\u0074le": Second\n---',
    expected: null,
  },
].map(({ name, markdown, expected }) => {
  const parsed = getDohcYDocFrontmatter(markdownToYDoc(markdown));
  const expectedProjection = expected === null ? {} : expected;
  if (expected !== undefined && !isDeepStrictEqual(expectedProjection, parsed)) {
    throw new Error(`frontmatter fixture ${name} disagrees with markdownToYDoc`);
  }
  return { name, markdown, expected: expected === undefined ? parsed : expected };
});

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
writeFixture("collection-schema-limits.json", {
  vectors: [
    {
      name: "fields-and-views-one-over-collection-limit",
      itemCount: 16_385,
      expectedItemCount: 16_384,
      referencedFieldIndex: 16_384,
      expectedReasons: [
        { code: "schema-collection-limit-exceeded", path: "/fields" },
        { code: "unknown-field-reference", path: "/views/0/groupBy" },
        { code: "schema-collection-limit-exceeded", path: "/views" },
      ],
    },
  ],
  reasonVectors: [
    {
      name: "reasons-one-over-collection-limit",
      itemCount: 16_385,
      expectedReasonCount: 16_384,
      expectedTerminalReason: {
        code: "schema-collection-limit-exceeded",
        path: "/reasons",
      },
    },
  ],
  optionVectors: [
    {
      name: "select-options-one-over-collection-limit",
      itemCount: 16_385,
      expectedItemCount: 16_384,
      expectedReasons: [
        {
          code: "schema-collection-limit-exceeded",
          path: "/fields/status/options",
        },
      ],
    },
  ],
});
writeFixture("collection-field-values.json", { vectors: fieldValues });
writeFixture("collection-field-pipeline.json", {
  version: 1,
  collectionPath: "pipeline",
  schemaYaml: pipelineSchemaYaml(pipelineValues),
  recordMarkdown: pipelineRecord,
  recordMarkdownSha256: createHash("sha256")
    .update(pipelineRecord, "utf8")
    .digest("hex"),
  supportFiles: [
    {
      path: "pipeline-targets/collection.yaml",
      text: "fields:\n  label:\n    type: text\n",
    },
    {
      path: "pipeline-targets/a.md",
      text: `---\nid: ${pipelineTargetA}\nlabel: Alpha\n---\n`,
    },
    {
      path: "pipeline-targets/z.md",
      text: `---\nid: ${pipelineTargetB}\nlabel: Omega\n---\n`,
    },
  ],
  vectors: pipelineValues,
});
writeFixture("collection-record-ids.json", { vectors: recordIds });
writeFixture("collection-frontmatter.json", { vectors: frontmatter });
writeFixture("collection-reason-codes.json", {
  schemaReasonCodes: COLLECTION_SCHEMA_REASON_CODES,
  fieldValueReasonCodes: FIELD_VALUE_REASON_CODES,
});
