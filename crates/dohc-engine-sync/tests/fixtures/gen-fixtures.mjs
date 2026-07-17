// Real TypeScript oracle for R10's cross-process security vocabulary.
// Regenerate with:
//   pnpm exec tsx crates/dohc-engine-sync/tests/fixtures/gen-fixtures.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_CHANNEL_WIRE_ID,
  GENERAL_CHANNEL_WIRE_ID,
  classifyEngineFilePath,
  classifyEngineFilePathForRead,
} from "../../../../packages/security-contract/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
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
writeFileSync(join(here, "security-contract.json"), `${JSON.stringify(fixture, null, 2)}\n`);
