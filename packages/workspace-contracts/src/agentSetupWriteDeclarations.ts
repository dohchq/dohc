import { z } from "zod";
import { AgentIncomingWebhookCreated, AgentIncomingWebhookCreateInput } from "./incomingWebhooks";
import type { SocketAdmission, WriteFamily } from "./writeDeclaration";

const admission: SocketAdmission = {
  receivedShare: "owner",
  readOnlyWorkspace: "handler-decides",
  run: "never-a-run",
  paths: "none",
};
const failed = z.object({ ok: z.literal(false), reason: z.string() }).strict();
export const OWNER_SETUP_REASON =
  "Only the owner's own agents set up the workspace, so shared profiles omit it. The handler refuses a shared view, a workspace the caller doesn't own, and any dohc agent run.";

const AutomationUseServerResult = z.union([
  z
    .object({
      ok: z.literal(true),
      outcome: z.enum(["moved", "handover-pending", "already-server"]),
      generation: z.number().int().nonnegative(),
      handoverFrom: z.string().min(1).max(256).nullable(),
    })
    .strict(),
  failed,
]);

export const AGENT_SETUP_WRITE_DECLARATIONS = {
  automationUseServer: {
    access: "write",
    capabilityId: "automation.host.choose",
    ipc: {
      none: "Settings › Advanced › Schedules run on keeps its own row, which also chooses a computer.",
    },
    socket: {
      verb: "automationUseServer",
      input: z.object({ generation: z.number().int().nonnegative() }).strict(),
      result: AutomationUseServerResult,
      admission,
    },
    cli: {
      command: ["automation", "use-server"],
      summary: "Move this workspace's automations to the server.",
      operands: "",
      flags: [
        {
          name: "--generation",
          value: "n",
          text: "Required. The generation dohc automation host printed.",
        },
      ],
      notes: [
        "Only the owner's own agents can move them, from a synced workspace. While a computer hands over, the server waits for it. If it stays offline, use Take over in Settings › Advanced.",
      ],
      example: ["--generation", "3"],
    },
    mcp: {
      tool: "dohc_use_server_for_automations",
      description:
        "Move a synced workspace's automations and schedules to the dohc server, so they run while the owner's computers are off. Pass the generation from dohc_read_automation_host. moved means the server runs them now. handover-pending names the computer that must release them first; if it stays offline, the owner uses Take over in Settings › Advanced. A stale generation is refused: read the host again.",
      levels: ["owner"],
      reason: OWNER_SETUP_REASON,
    },
  },
  webhookCreate: {
    access: "write",
    capabilityId: "workspace.webhooks.create",
    ipc: {
      none: "Settings › Secrets › Incoming webhooks keeps its own row, which also shows the token.",
    },
    socket: {
      verb: "webhookCreate",
      input: AgentIncomingWebhookCreateInput,
      result: z.union([
        AgentIncomingWebhookCreated.extend({ ok: z.literal(true) }).strict(),
        failed,
      ]),
      admission,
    },
    cli: {
      command: ["webhook", "create"],
      summary: "Create an incoming webhook address that adds records to a private Collection.",
      operands: "<name>",
      flags: [
        {
          name: "--collection",
          value: "path",
          text: "Required. The Collection's folder, relative to the workspace root.",
        },
      ],
      notes: [
        "The address is a secret: anyone who has it can add records. dohc shows it once.",
        "If you don't know whether a create worked, run dohc webhook list before you try again.",
        "Creating needs the server to run this workspace's automations, with no handover waiting, and a synced Collection.",
      ],
      example: ["Waitlist", "--collection", "waitlist"],
    },
    mcp: {
      tool: "dohc_create_incoming_webhook",
      description:
        "Create an incoming webhook for a private Collection in a synced workspace the person you work for owns. collection is the Collection's folder, relative to the workspace root. Returns the address once, as endpointUrl. It is a secret: anyone who has it can add records, so give it only to the person you work for or the site that posts to it. If you don't know whether a create worked, list incoming webhooks before you try again. Creating needs the server to run the workspace's automations (dohc_use_server_for_automations) with no handover waiting. The owner deletes or rotates it in Settings › Secrets › Incoming webhooks.",
      levels: ["owner"],
      reason: OWNER_SETUP_REASON,
    },
  },
} as const satisfies WriteFamily;
