import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { z } from "zod";
import { cliStateDirs, type CliClientOptions } from "./client";
import { DohcCliError } from "./errors";

const Diagnostic = z.object({
  code: z.string(),
  path: z.string(),
  line: z.number().optional(),
  automation: z.string().nullable().optional(),
});
export const ValidateResult = z.object({
  ok: z.boolean(),
  path: z.string(),
  diagnostics: z.array(Diagnostic),
});
const Workspace = z.object({ workspaceId: z.string(), rootPath: z.string(), kind: z.string() });
export const WorkspaceInfoResult = z.object({
  workspaces: z.array(Workspace.extend({ current: z.boolean() })),
});
type LocalResult = z.infer<typeof ValidateResult> | z.infer<typeof WorkspaceInfoResult>;

export type LocalCommand =
  | { verb: "collectionValidate" | "automationValidate"; path: string }
  | { verb: "workspaceInfo"; workspaceId?: string };

async function validate(
  { verb, path }: Extract<LocalCommand, { path: string }>,
  cwd: string,
): Promise<LocalResult> {
  const text = await readFile(resolve(cwd, path), "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new DohcCliError(`cannot read ${path}: ${error.code}`);
  });
  const diagnostics =
    verb === "collectionValidate" ? parseCollectionSchema(text).reasons : automationProblems(text);
  return { ok: diagnostics.length === 0, path, diagnostics };
}

function automationProblems(text: string): z.infer<typeof Diagnostic>[] {
  const parsed = parseAutomationsFile(text);
  if (parsed.status === "unreadable") return [parsed.diagnostic];
  return parsed.entries.flatMap((entry) =>
    entry.status === "invalid"
      ? entry.diagnostics.map((diagnostic) => ({ ...diagnostic, automation: entry.id }))
      : [],
  );
}

async function workspaceInfo(
  workspaceId: string | undefined,
  cwd: string,
  client: CliClientOptions,
) {
  let text: string | null = null;
  for (const stateDir of cliStateDirs(client))
    text ??= await readFile(join(stateDir, "dohc-workspaces.json"), "utf8").catch(() => null);
  let workspaces: z.infer<typeof Workspace>[];
  try {
    workspaces = z.array(Workspace).parse(text === null ? [] : (JSON.parse(text).workspaces ?? []));
  } catch {
    throw new DohcCliError("the workspace list on this computer is unreadable");
  }
  const real = (path: string) => realpath(path).catch(() => resolve(path));
  const here = await real(cwd);
  const depths = await Promise.all(
    workspaces.map(async ({ rootPath }) => {
      const root = await real(rootPath);
      return here === root || here.startsWith(root.replace(/[\\/]?$/u, sep)) ? root.length : -1;
    }),
  );
  const deepest = Math.max(0, ...depths);
  return {
    workspaces: workspaces.map((workspace, index) => ({
      ...workspace,
      current: workspaceId ? workspace.workspaceId === workspaceId : depths[index] === deepest,
    })),
  };
}

export function runLocalCommand(command: LocalCommand, cwd: string, client: CliClientOptions) {
  return command.verb === "workspaceInfo"
    ? workspaceInfo(command.workspaceId, cwd, client)
    : validate(command, cwd);
}

export function renderLocalResult(result: LocalResult): string {
  if ("workspaces" in result)
    return result.workspaces
      .map((w) => `${w.current ? "*" : " "} ${w.workspaceId}  ${w.kind}  ${w.rootPath}`)
      .join("\n");
  return [
    `${result.ok ? "Valid" : "Problems in"}: ${result.path}`,
    ...result.diagnostics.map(
      ({ code, path, line, automation }) =>
        `  ${code} at ${path || "/"}${line === undefined ? "" : ` line ${line}`}${automation ? ` in ${automation}` : ""}`,
    ),
  ].join("\n");
}
