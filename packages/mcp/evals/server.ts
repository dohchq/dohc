// The MCP server an eval sample connects to: the real dohc server from this checkout, with
// the stand-in app behind it. The agent harness starts it over stdio.
//   node --import tsx evals/server.ts <case id> <workspace folder> <unanswered-request log>

import { appendFileSync, writeFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDohcMcpServer } from "../src/server";
import type { DatasetSnapshot, FrontendVerificationRecord } from "./case";
import { CASES } from "./cases";
import { fakeDesktop } from "./desktop";
import { EVERYDAY_CASES } from "./everydayCases";

const [caseId, root, unansweredLog, homeArg, writesLog, snapshotsFile, verificationsFile] =
  process.argv.slice(2);
const evalCase = [...CASES, ...EVERYDAY_CASES].find((candidate) => candidate.id === caseId);
if (!evalCase || !root || !unansweredLog) {
  process.stderr.write(
    "usage: server.ts <case id> <workspace folder> <unanswered-request log> [home folder] [writes log] [snapshots file] [verifications file]\n",
  );
  process.exit(1);
}

const onWrite = writesLog
  ? (path: string, contentSha256: string) => {
      appendFileSync(
        writesLog,
        `${JSON.stringify({ path: path.replaceAll("\\", "/"), sha256: contentSha256 })}\n`,
      );
    }
  : undefined;

const datasetSnapshots: Record<string, DatasetSnapshot> = {};
const onDatasetSnapshot = snapshotsFile
  ? (datasetPath: string, snapshot: DatasetSnapshot) => {
      datasetSnapshots[datasetPath] = snapshot;
      writeFileSync(snapshotsFile, JSON.stringify(datasetSnapshots));
    }
  : undefined;

const frontendVerifications: Record<string, FrontendVerificationRecord> = {};
const onFrontendVerified = verificationsFile
  ? (appRoot: string, record: FrontendVerificationRecord) => {
      frontendVerifications[appRoot] = record;
      writeFileSync(verificationsFile, JSON.stringify(frontendVerifications));
    }
  : undefined;

const desktopOptions = {
  ...(onWrite ? { onWrite } : {}),
  ...(onDatasetSnapshot ? { onDatasetSnapshot } : {}),
  ...(onFrontendVerified ? { onFrontendVerified } : {}),
};

const answers = {
  ...(evalCase.setupDesktop
    ? await evalCase.setupDesktop(
        root,
        Object.keys(desktopOptions).length > 0 ? desktopOptions : undefined,
      )
    : {}),
  ...evalCase.desktop,
};

const server = createDohcMcpServer({
  root,
  home: homeArg || root,
  request: fakeDesktop({ root, answers, unansweredLog, ...(onWrite ? { onWrite } : {}) }),
});
await server.connect(new StdioServerTransport());
