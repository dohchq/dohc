import { AGENT_RUN_HISTORY_DECLARATIONS } from "./agentRunHistoryDeclarations";
import { CAPTURE_DECLARATIONS } from "./captureDeclarations";
import { CHAT_DECLARATIONS } from "./chatDeclarations";
import { INBOX_DECLARATIONS } from "./inboxDeclarations";
import { LINKS_DECLARATIONS } from "./linksDeclarations";
import { MEMBER_APPS_DECLARATIONS } from "./memberAppsDeclarations";
import { RETRIEVAL_DECLARATIONS } from "./retrievalDeclarations";
import { ENVELOPE_FIELDS, type OperationFamily } from "./operationDeclaration";

// Every declared family, listed once. The capability table, the CLI, and the
// IPC tables take their families from here, so each door loads the checks below.
export const DECLARATION_FAMILIES = {
  capture: CAPTURE_DECLARATIONS,
  chat: CHAT_DECLARATIONS,
  inbox: INBOX_DECLARATIONS,
  links: LINKS_DECLARATIONS,
  retrieval: RETRIEVAL_DECLARATIONS,
  agentRunHistory: AGENT_RUN_HISTORY_DECLARATIONS,
  memberApps: MEMBER_APPS_DECLARATIONS,
} as const;

// The type refuses these, but a cast can hide one from it.
for (const family of Object.values<OperationFamily>(DECLARATION_FAMILIES)) {
  for (const [name, { access, input }] of Object.entries(family)) {
    if (access !== "read")
      throw new Error(`${name} is declared as ${String(access)}. Only reads can be declared.`);
    const field = ENVELOPE_FIELDS.find((envelope) => Object.hasOwn(input.shape, envelope));
    if (field) throw new Error(`${name} input names ${field}, which its doors set.`);
  }
}
