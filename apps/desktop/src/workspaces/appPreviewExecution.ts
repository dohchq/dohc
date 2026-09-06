import { preferredBuildOutput } from "@dohc/workspace-core";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { isInside } from "../security/pathContainment";
import type { SitePreviewExecutionInput } from "../ipc/sitePreviewIpc";
import { prepareOwnedStaticSitePreview } from "./ownedStaticSiteFileSource";
import { buildOutputSiteRoot } from "./sitePackage";
import { buildSite, startSiteDevServer, startStaticSitePreview, type SiteLogEntry } from "./siteRunner";
import { commandForSiteScript } from "./siteScriptCommand";
import { START_CANCELLED_MESSAGE } from "./sitePreviewLifecycle";
import type { ShareViewFiles, ShareViewFilesTarget } from "./shareViewFiles";

async function relativeWorkspacePath(
  workspaceRoot: string,
  absolutePath: string,
): Promise<string> {
  const [realWorkspaceRoot, realAbsolutePath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(absolutePath),
  ]);
  const rel = relative(realWorkspaceRoot, realAbsolutePath).replaceAll("\\", "/");
  // Strict on purpose: the workspace root itself is not a build output.
  if (rel === "" || !isInside(realWorkspaceRoot, realAbsolutePath)) {
    throw new Error(`Build output escaped the workspace: ${absolutePath}`);
  }
  return rel;
}

function buildOutputRelativeToApp(appRoot: string, workspaceRelativeOutput: string): string {
  if (appRoot === ".") return workspaceRelativeOutput;
  if (workspaceRelativeOutput === appRoot) return ".";
  if (!workspaceRelativeOutput.startsWith(`${appRoot}/`)) {
    throw new Error(
      `Build output must be inside the app folder: ${workspaceRelativeOutput}`,
    );
  }
  return workspaceRelativeOutput.slice(appRoot.length + 1);
}

function recentAppBuildLogText(logs: SiteLogEntry[]): string {
  const text = logs
    .slice(-3)
    .map((log) => log.text)
    .join("\n")
    .trim();
  return text.length > 2000 ? `[truncated]\n${text.slice(-2000)}` : text;
}

export function createAppPreviewExecution(dependencies: {
  readonly shareViewFiles: Pick<ShareViewFiles, "read">;
  readonly shareViewFilesTargetForPath: (
    workspace: { workspaceId: string },
    path: string,
  ) => Promise<{ target: ShareViewFilesTarget; path: string } | null>;
}) {
  async function executeAppPreview(input: SitePreviewExecutionInput) {
    if (input.mode === "static") {
      const target = await prepareOwnedStaticSitePreview({
        site: input.site,
        sharedView: input.sharedView,
        resolveOwner: (path) =>
          dependencies.shareViewFilesTargetForPath({ workspaceId: input.workspaceId }, path),
        readOwner: async (ownerTarget, ownerPath) => {
          const read = await dependencies.shareViewFiles.read(ownerTarget, {
            kind: "asset",
            path: ownerPath,
          });
          if (read.kind !== "asset") {
            throw new Error("Shared app file returned an invalid result.");
          }
          return read.bytes;
        },
      });
      const handle = await startStaticSitePreview(input.workspaceRoot, target.root, {
        authority: input.site.authority,
        entry: target.entry,
        ...(target.fileSource ? { fileSource: target.fileSource } : {}),
      });
      return {
        handle,
        result: {
          siteRoot: input.site.root,
          mode: input.mode,
          logs: [],
        },
      };
    }

    if (input.mode === "dev") {
      if (
        !input.site.configuredScripts.dev &&
        !input.site.scripts.dev &&
        !input.site.configuredScripts.start &&
        !input.site.scripts.start
      ) {
        throw new Error(`App has no dev or start script: ${input.site.root}`);
      }
      const script =
        input.site.configuredScripts.dev || input.site.scripts.dev ? "dev" : "start";
      const command = commandForSiteScript(input.site, script);
      const handle = await startSiteDevServer({
        workspaceRoot: input.workspaceRoot,
        siteRoot: input.site.root,
        command: command.command,
        args: command.args,
        signal: input.signal,
      });
      return {
        handle,
        result: {
          siteRoot: input.site.root,
          mode: input.mode,
          logs: handle.logs(),
        },
      };
    }

    let logs: SiteLogEntry[] = [];
    let build:
      | {
          ok: boolean;
          command: string;
          args: string[];
          outputPath: string | null;
          exitCode: number | null;
        }
      | undefined;
    let outputRoot = preferredBuildOutput(input.site);
    if (input.site.configuredScripts.build || input.site.scripts.build) {
      const command = commandForSiteScript(input.site, "build");
      const result = await buildSite({
        workspaceRoot: input.workspaceRoot,
        siteRoot: input.site.root,
        command: command.command,
        args: command.args,
        output: outputRoot ?? undefined,
        signal: input.signal,
      });
      logs = result.logs;
      build = {
        ok: result.ok,
        command: result.command,
        args: result.args,
        outputPath: result.outputPath,
        exitCode: result.exitCode,
      };
      if (!result.ok || !result.outputPath) {
        const recentLogs = recentAppBuildLogText(result.logs);
        throw new Error(
          `App build failed or did not produce a static output folder.${
            recentLogs ? `\n\nRecent output:\n${recentLogs}` : ""
          }`,
        );
      }
      outputRoot = buildOutputRelativeToApp(
        input.site.root,
        await relativeWorkspacePath(input.workspaceRoot, result.outputPath),
      );
    }
    if (!input.isCurrent() || input.signal.aborted) {
      throw new Error(START_CANCELLED_MESSAGE);
    }
    if (!outputRoot) throw new Error(`App has no build output to preview: ${input.site.root}`);
    const handle = await startStaticSitePreview(
      input.workspaceRoot,
      buildOutputSiteRoot(input.site, outputRoot),
      { authority: input.site.authority },
    );
    return {
      handle,
      result: {
        siteRoot: input.site.root,
        mode: input.mode,
        logs,
        ...(build ? { build } : {}),
      },
    };
  }

  return executeAppPreview;
}
