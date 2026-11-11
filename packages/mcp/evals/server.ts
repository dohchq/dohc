// The MCP server an eval sample connects to: the real dohc server from this checkout, with
// the stand-in app behind it. The agent harness starts it over stdio.
//   node --import tsx evals/server.ts <case id> <workspace folder> <unanswered-request log>

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDohcMcpServer } from "../src/server";
import { CASES } from "./cases";
import { fakeDesktop } from "./desktop";

const [caseId, root, unansweredLog] = process.argv.slice(2);
const evalCase = CASES.find((candidate) => candidate.id === caseId);
if (!evalCase || !root || !unansweredLog) {
  process.stderr.write("usage: server.ts <case id> <workspace folder> <unanswered-request log>\n");
  process.exit(1);
}

const server = createDohcMcpServer({
  root,
  home: root,
  request: fakeDesktop({ root, answers: evalCase.desktop ?? {}, unansweredLog }),
});
await server.connect(new StdioServerTransport());
