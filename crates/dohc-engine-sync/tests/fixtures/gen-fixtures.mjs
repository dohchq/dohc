// Real TypeScript oracle for R10's cross-process security vocabulary.
// Regenerate with:
//   node crates/dohc-engine-sync/tests/fixtures/gen-fixtures.mjs
//   DOHC_FIXTURE_OUT=<directory> node crates/dohc-engine-sync/tests/fixtures/gen-fixtures.mjs
//
// The oracle is TypeScript, so this registers tsx itself rather than requiring
// the caller to run it under `tsx` — the same shape the dohc-engine-collab
// generator uses, so the fixture drift check can run both with plain node.
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
// oracle imports `@dohc/workspace-core`, whose link pnpm writes to
// `packages/security-contract/node_modules/`, so a checkout without its own
// install cannot run this generator no matter where tsx is found. Resolving tsx
// elsewhere would only turn a clear "install the dependencies" SKIP into a
// module-not-found stack trace.
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
    `could not resolve tsx/esm/api from any base:\n${tsxBases.join("\n")}\nrun 'pnpm install --offline --frozen-lockfile' or set DOHC_TSX_BASE before regenerating security-contract fixtures`,
  );
}
const { register } = await import(pathToFileURL(tsxApiPath).href);
const unregisterTsx = register();
const {
  AGENT_CHANNEL_WIRE_ID,
  GENERAL_CHANNEL_WIRE_ID,
  classifyEngineFilePath,
  classifyEngineFilePathForRead,
} = await import(
  pathToFileURL(join(repoRoot, "packages/security-contract/src/index.ts")).href
);
await unregisterTsx();

const inputs = [
  ["notes/today.md", true],
  ["config/app.env", true],
  [".env", true],
  ["config/.env.local", true],
  ["config/secret.env. ", true],
  ["notes/.git/config", true],
  ["node_modules/pkg/index.js", true],
  ["shared-with-me/alex/brief.md", true],
  ["shared-with-me/alex/.env", true],
  ["shared-with-me/.env/brief.md", true],
  ["nested/.dohc-write-temp", true],
  ["windows\\backslash.env", false],
  ["encoded/secrets%2eenv", false],
  ["../escape.env", false],
  ["C:/absolute.env", false],
  // Secret-rule surface. The share classifier and the files policy each carry
  // three secret rules — an `.env` segment at any depth, a basename ending
  // `.env`, and a basename starting `.env.` — under the same case folding and
  // trailing dot/space alias strip. One vector per rule, plus the near misses
  // that must stay tracked, so a rule that changes on one side alone moves a
  // vector.
  ["apps/site/.env/local", true],
  ["deploy/PROD.ENV", true],
  ["config/.ENV.LOCAL", true],
  [".env.", true],
  ["config/.env.local. ", true],
  [".envrc", true],
  ["notes/env/config.md", true],
  ["notes/envelope.md", true],
  // Ignored and reserved segments outrank a secret-shaped name on both sides.
  ["node_modules/pkg/.env", true],
  [".dohc/config.env", true],
  // Secret classes neither classifier holds today. They are the shapes a
  // future secret rule would most likely name, so adding that rule to one
  // classifier alone moves one of these vectors and the equivalence test bites.
  ["keys/server.pem", true],
  ["home/.ssh/id_rsa", true],
  ["secrets/api-token.txt", true],
  // Secret material outside the share grammar. The share classifier fails
  // closed on the `.` segment while the files policy normalizes it away and
  // reads the path as secret.
  ["./config/.env", false],
];

const vectors = inputs.map(([path, rustClaimed]) => ({
  path,
  rustClaimed,
  write: classifyEngineFilePath(path).kind,
  read: classifyEngineFilePathForRead(path).kind,
}));

const fixture = {
  wireIds: {
    agent: AGENT_CHANNEL_WIRE_ID,
    general: GENERAL_CHANNEL_WIRE_ID,
  },
  vectors,
};
writeFileSync(
  join(outputDir, "security-contract.json"),
  `${JSON.stringify(fixture, null, 2)}\n`,
);
