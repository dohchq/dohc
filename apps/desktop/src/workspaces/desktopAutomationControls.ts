import { WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { z } from "zod";
import { createAutomationControls, type AutomationDeliveryStatus } from "./automationControls";
import type { AutomationFileContent } from "@dohc/workspace-contracts/automation-controls";
import { createOwnedWorkspaceFileReader } from "./ownedWorkspaceFileReader";
import { recordedShareSelector } from "./shareViewRecords";
import { resolveRegisteredShareViewFilesTarget } from "./shareViewFilesTarget";
import type { ResolvedShareViewFilesTarget, ShareViewFiles, ShareViewFilesTarget } from "./shareViewFiles";
import type { RegistryEntry } from "./registryStore";
import type { WorkspaceAuthorityOperation } from "./workspaceAuthorityOwner";
import { withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";

const deliverySchema = z.object({ contentHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  state: z.enum(["pending", "accepted", "refused"]), reason: z.string().optional() });

export function createDesktopAutomationControls<State>(input: {
  operation: WorkspaceAuthorityOperation<RegistryEntry, State>;
  files: ShareViewFiles;
  sessions(): EngineWorkspaceSessions;
  canSwitch(target: ResolvedShareViewFilesTarget, collectionPath: string): Promise<boolean>;
  edited(target: ShareViewFilesTarget): void;
}) {
  const { operation } = input;
  const reader = createOwnedWorkspaceFileReader({ workspace: operation.workspace, files: input.files });
  async function shared(path: string) {
    operation.assertCurrent();
    const found = await reader.resolveShare(path);
    operation.assertCurrent();
    if (!found) return null;
    const target = resolveRegisteredShareViewFilesTarget(operation.workspace, found.target);
    if (!target) throw new Error("This share is no longer available.");
    return { ...found, resolved: target };
  }
  function assertTarget(found: NonNullable<Awaited<ReturnType<typeof shared>>>): void {
    operation.assertCurrent();
    if (JSON.stringify(resolveRegisteredShareViewFilesTarget(operation.workspace, found.target)) !== JSON.stringify(found.resolved)) {
      throw new Error("The shared file session changed. Read the automations again.");
    }
  }
  return createAutomationControls({
    resolve: async collectionPath => {
      const path = `${collectionPath}/automations.yaml`;
      const found = await shared(path);
      let content: AutomationFileContent | null = null;
      let delivery: AutomationDeliveryStatus | null = null;
      let canSwitch = false;
      let switchReason = "Use the Collection's automation editor to change its definition.";
      if (!found) {
        try { content = await reader.readText(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } else {
        const target = found.resolved;
        const grant = recordedShareSelector(target.grantedSelector);
        const selected = grant !== null && (grant.paths.length === 0 && grant.versionId !== null
          || grant.paths.some(path => found.path === path || found.path.startsWith(`${path}/`)));
        if (selected) {
          try {
            const read = await input.files.read(found.target, { kind: "text", path: found.path });
            if (read.kind !== "text") throw new Error("Shared text read returned an invalid result.");
            content = read;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        switchReason = target.kind === "mount" ? "Open this share in its own workspace to switch automations."
          : "This share does not allow automation switches.";
        const folder = found.path.slice(0, -"/automations.yaml".length);
        if (target.kind === "standalone" && !target.ended && target.shareId && grant?.access === "edit"
          && grant.versionId === null && grant.paths.some(path => folder === path || folder.startsWith(`${path}/`))) {
          try {
            canSwitch = await input.canSwitch(target, folder);
            switchReason = "The server does not accept automation switches for this Collection.";
          } catch { switchReason = "The server could not confirm automation switches. Try again when connected."; }
        }
        if (selected && target.kind === "standalone" && target.shareId && grant?.versionId === null) {
          delivery = await input.sessions().run({ workspaceId: target.storeWorkspaceId, rootPath: target.rootPath,
            shareMount: true, attachmentId: operation.workspace.attachmentId }, async binding =>
            deliverySchema.parse(await new WorkspaceDaemonRequester(binding.client).request("share.direct.status", {
              workspaceId: target.storeWorkspaceId, shareId: target.shareId!, path: found.path,
              grantedSelector: { paths: grant.paths, versionId: grant.versionId, access: grant.access },
            }, { workspace: binding.workspace })));
        }
      }
      operation.assertCurrent();
      if (found) assertTarget(found);
      return { content, canSwitch, delivery, ...(!canSwitch ? { switchReason } : {}) };
    },
    write: async (path, text, expectedContentHash, submitId) => {
      const found = await shared(path);
      if (!found || found.target.kind !== "standalone") return { status: "unavailable", reason: "Open an Edit share in its own workspace to switch automations." };
      const outcome = await withStaleSensitiveWorkspaceOperation(operation.workspace.rootPath, lease => {
        assertTarget(found);
        return input.files.change(lease, found.target, { kind: "save", path: found.path, text, expectedContentHash });
      });
      operation.assertCurrent();
      if (outcome.status !== "committed") {
        input.edited(found.target);
        return { status: "unknown", submitId };
      }
      const result = outcome.value;
      if (typeof result !== "object" || result === null || !("status" in result)) throw new Error("The automation save returned no result.");
      if (result.status === "conflict") return { status: "conflict" };
      input.edited(found.target);
      return { status: "written", sync: "pending" };
    },
  });
}
