// Compile-only contracts, enforced by the package typecheck.
import { z } from "zod";
import { LINKS_DECLARATIONS } from "./linksDeclarations";
import type { OperationDeclaration } from "./operationDeclaration";

const { linksEdges } = LINKS_DECLARATIONS;

({ ...linksEdges, input: linksEdges.input.extend({ subject: z.string() }) }) satisfies OperationDeclaration;
// @ts-expect-error Only reads may be declared. The CLI socket runs a declared verb without write admission.
({ ...linksEdges, access: "write" }) satisfies OperationDeclaration;
// @ts-expect-error A declaration states that it is a read.
({ ...linksEdges, access: undefined }) satisfies OperationDeclaration;
// @ts-expect-error The MCP server sets cwd to its own workspace.
({ ...linksEdges, input: linksEdges.input.extend({ cwd: z.string() }) }) satisfies OperationDeclaration;
// @ts-expect-error The MCP server sets the actor.
({ ...linksEdges, input: linksEdges.input.extend({ actor: z.string() }) }) satisfies OperationDeclaration;
// @ts-expect-error The MCP server sets its own agent id.
({ ...linksEdges, input: z.object({ agentId: z.string().optional() }).strict() }) satisfies OperationDeclaration;
// @ts-expect-error The IPC row sets the workspace.
({ ...linksEdges, input: linksEdges.input.extend({ workspaceId: z.string() }) }) satisfies OperationDeclaration;
// @ts-expect-error The CLI request carries the run secret.
({ ...linksEdges, input: linksEdges.input.extend({ runSecret: z.string() }) }) satisfies OperationDeclaration;
