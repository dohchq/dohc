// The MCP server an eval sample connects to: the real dohc server from this checkout, with
// the stand-in app behind it. The agent harness starts it over stdio.
//   node --import tsx evals/server.ts <case id> <workspace folder> <unanswered-request log>

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDohcMcpServer } from "../src/server";
import { CASES } from "./cases";
import { fakeDesktop } from "./desktop";
import { EVERYDAY_CASES } from "./everydayCases";

const [caseId, root, unansweredLog, homeArg] = process.argv.slice(2);
const evalCase = [...CASES, ...EVERYDAY_CASES].find((candidate) => candidate.id === caseId);
if (!evalCase || !root || !unansweredLog) {
  process.stderr.write(
    "usage: server.ts <case id> <workspace folder> <unanswered-request log> [home folder]\n",
  );
  process.exit(1);
}

const answers = {
  ...(evalCase.setupDesktop ? evalCase.setupDesktop(root) : {}),
  ...evalCase.desktop,
};

const server = createDohcMcpServer({
  root,
  home: homeArg || root,
  request: fakeDesktop({ root, answers, unansweredLog }),
});
await server.connect(new StdioServerTransport());
