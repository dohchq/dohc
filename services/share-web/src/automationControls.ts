import { createHash } from "node:crypto";
import { z } from "zod";
import { readBoundedJson } from "@dohc/service-http";
import { MAX_AUTOMATIONS_FILE_BYTES } from "@dohc/workspace-contracts/automations";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
import { automationDefinitionList, serializeAutomationSwitch, type AutomationSwitchInput, type AutomationSwitchResult } from "@dohc/workspace-contracts/automation-controls";
import { collectionWriteBody, COLLECTION_WRITES_PATH, parseCollectionWriteOutcome } from "./collectionWrites";
import { boundedBytes, fileInventorySchema, ResponseTooLargeError } from "./remoteMcp";

const selectorSchema = z.object({ access: z.enum(["view", "comment", "edit"]), effectiveSelector: z.object({ versionId: z.string().nullable(), paths: z.array(z.string()) }) });

export function createSharedAutomationControls(options: {
  metadata: Record<string, unknown>;
  request(path: string, init?: RequestInit): Promise<Response>;
  signal: AbortSignal;
  deadlineAtMs: number;
}) {
  function pathOf(collectionPath: string): string {
    if (!isNormalizedRelativePath(collectionPath)) throw new Error("Choose a Collection in this share.");
    return `${collectionPath}/automations.yaml`;
  }
  function canSwitch(collectionPath: string): boolean {
    const parsed = selectorSchema.safeParse(options.metadata);
    return parsed.success && parsed.data.access === "edit" && parsed.data.effectiveSelector.versionId === null
      && parsed.data.effectiveSelector.paths.some(path => collectionPath === path || collectionPath.startsWith(`${path}/`));
  }
  async function read(collectionPath: string, base?: string) {
    const path = pathOf(collectionPath);
    const response = await options.request(`/api/view/current?${new URLSearchParams({ collectionPath })}`);
    if (!response.ok) throw new Error("This share is unavailable. Try again.");
    const inventory = fileInventorySchema.parse(await readBoundedJson(response, 1024 * 1024, options.signal));
    const file = inventory.files.find(file => file.path === path);
    // A file selector never grants a sibling lookup.
    if (!file) return null;
    const hash = base ?? file.blobSha256;
    const blob = await options.request(`/api/view/blob/${hash}`);
    if (!blob.ok) throw new Error("The shared definition is unavailable. Read the list again.");
    const writable = canSwitch(collectionPath) && file.automationSwitchable === true;
    let bytes: Buffer;
    try { bytes = await boundedBytes(blob, MAX_AUTOMATIONS_FILE_BYTES, options.signal); }
    catch (error) {
      if (!(error instanceof ResponseTooLargeError)) throw error;
      return { content: { text: "", contentHash: hash, truncated: true }, canSwitch: writable };
    }
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("The shared definition returned different content.");
    return { content: { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), contentHash: hash, truncated: false },
      canSwitch: writable };
  }
  return {
    async list(collectionPath: string) {
      const resolved = await read(collectionPath);
      return automationDefinitionList(resolved?.content ?? null, resolved?.canSwitch ?? false, "accepted",
        resolved?.canSwitch ? undefined : "The server does not accept automation switches for this Collection or share.");
    },
    async switch(collectionPath: string, input: AutomationSwitchInput): Promise<AutomationSwitchResult> {
      pathOf(collectionPath);
      if (!canSwitch(collectionPath)) return { status: "unavailable", reason: "This share does not allow automation switches." };
      // Old shared blobs remain readable through the existing history transport.
      // Rebuilding from the same base gives a lost-reply retry the same relay payload.
      const resolved = await read(collectionPath, input.expectedContentHash);
      if (resolved && !resolved.canSwitch) return { status: "unavailable", reason: "The server does not accept automation switches for this Collection." };
      const prepared = await serializeAutomationSwitch(resolved?.content ?? null, input);
      if (prepared.status !== "prepared") return prepared;
      const hash = createHash("sha256").update(prepared.text).digest("hex");
      try {
        const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(0, options.deadlineAtMs - Date.now() - 5000))]);
        const response = await options.request(COLLECTION_WRITES_PATH, { method: "POST", signal,
          body: collectionWriteBody(input.submitId, [{ path: pathOf(collectionPath), text: prepared.text, basedOnBlobSha256: input.expectedContentHash }], Date.now()) });
        const outcome = parseCollectionWriteOutcome(response.status, await readBoundedJson(response, 16 * 1024, signal).catch(() => null));
        switch (outcome.outcome) {
          case "accepted": return { status: "written", contentHash: hash, sync: "accepted" };
          case "stale": return { status: "conflict" };
          case "refused": return { status: "refused-write", reason: outcome.reason };
          case "unavailable": return { status: "unavailable", reason: "This share is unavailable." };
          default: return { status: "unknown", submitId: input.submitId };
        }
      } catch { return { status: "unknown", submitId: input.submitId }; }
    },
  };
}
