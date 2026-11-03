import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { type CodexConfigFiles, codexConfigFiles, codexMayRunWithoutLogin, codexRunConfig, codexTrustKeys } from "./codexRunConfig";
import { createTestScratch } from "../workspaces/testTemp";

const SYSTEM = "C:\\ProgramData\\OpenAI\\Codex\\config.toml";
const USER = "C:\\Users\\Sam\\.codex\\config.toml";
const REQUIREMENTS = "C:\\ProgramData\\OpenAI\\Codex\\requirements.toml";
const NONE: CodexConfigFiles = { requirements: [], config: [] };

function missing(path: string): never {
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

// The run's entries on Windows, with the person's config files as given.
function windowsRun(files: Record<string, string> = {}, paths: CodexConfigFiles | null = { requirements: [REQUIREMENTS], config: [SYSTEM, USER] }): string[] {
  return codexRunConfig({
    rootPath: "C:\\Users\\Sam\\dohc\\personal",
    runId: "run_1",
    platform: "win32",
    files: paths,
    readConfig: (path) => files[path] ?? missing(path),
    realPath: (path) => path,
  });
}

function entry(entries: string[], prefix: string): string | undefined {
  return entries.filter((_, index) => index % 2 === 1).find((value) => value.startsWith(prefix));
}

describe("a dohc Codex run", () => {
  it("keeps .dohc read-only under a profile named for the run, and doesn't trust the workspace", () => {
    const entries = windowsRun();
    const profile = entry(entries, "default_permissions=")!.slice("default_permissions=".length);
    expect(profile).toMatch(/^'dohc_run_[0-9a-f]{16}'$/u);
    expect(entries).toEqual([
      "--config", `permissions.${profile.slice(1, -1)}={extends=':workspace',filesystem={':workspace_roots'={'.dohc'='read'}}}`,
      "--config", `default_permissions=${profile}`,
      "--config", "projects={'c:\\users\\sam\\dohc\\personal'={trust_level='untrusted'},'\\\\?\\c:\\users\\sam\\dohc\\personal'={trust_level='untrusted'}}",
      "--config", "windows.sandbox='unelevated'",
    ]);
    const other = codexRunConfig({ rootPath: "C:\\w", runId: "run_2", platform: "win32", files: NONE });
    expect(entry(other, "default_permissions=")).not.toBe(`default_permissions=${profile}`);
  });

  it("names the workspace the way each of Codex's trust lookups spells it", () => {
    expect(codexTrustKeys("C:\\Users\\JOSÉ\\ws", "win32", () => "C:\\Users\\JOSÉ\\Ws")).toEqual([
      "c:\\users\\josÉ\\ws",
      "\\\\?\\c:\\users\\josÉ\\ws",
    ]);
    expect(codexTrustKeys("D:\\link\\ws\\", "win32", () => "C:\\real\\ws")).toEqual([
      "c:\\real\\ws",
      "d:\\link\\ws",
      "\\\\?\\c:\\real\\ws",
    ]);
    expect(codexTrustKeys("\\\\server\\share\\ws", "win32", (path) => path)).toEqual([
      "\\\\server\\share\\ws",
      "\\\\?\\unc\\server\\share\\ws",
    ]);
    expect(codexTrustKeys("/var/folders/ws", "darwin", () => "/private/var/folders/ws")).toEqual([
      "/private/var/folders/ws",
      "/var/folders/ws",
    ]);
    expect(codexTrustKeys("/home/Sam/ws", "linux", (path) => path)).toEqual(["/home/Sam/ws"]);
    expect(codexTrustKeys("/gone", "linux", () => missing("/gone"))).toEqual(["/gone"]);
    // Under WSL, a folder on a Windows drive.
    expect(codexTrustKeys("/mnt/C/Users/Sam/ws", "linux", (path) => path)).toEqual(["/mnt/c/users/sam/ws", "/mnt/C/Users/Sam/ws"]);
    expect(codexTrustKeys("/mnt/Data/ws", "linux", (path) => path)).toEqual(["/mnt/Data/ws"]);
  });

  it("writes a trust entry Codex can parse for any folder name", () => {
    for (const rootPath of ["/home/o'brien/ws", "/home/sam/a\u007fb", "/home/sam/tab\there", "/home/sam/back\\slash"]) {
      const projects = entry(codexRunConfig({ rootPath, runId: "run_1", platform: "linux", files: NONE, realPath: (path) => path }), "projects=")!;
      expect(parse(projects)).toEqual({ projects: { [rootPath]: { trust_level: "untrusted" } } });
    }
  });

  it("picks the unelevated Windows sandbox only when neither the person's config nor the system requirements choose one", () => {
    expect(entry(windowsRun(), "windows.sandbox=")).toBe("windows.sandbox='unelevated'");
    expect(entry(windowsRun({ [USER]: "model = 'gpt-5'\n[features]\nshell_tool = true\n" }), "windows.sandbox=")).toBe("windows.sandbox='unelevated'");
    const choices: Record<string, string>[] = [
      { [USER]: "[windows]\nsandbox = 'elevated'\n" },
      { [USER]: "windows = { sandbox = 'mxc' }\n" },
      { [USER]: "[profiles.work.windows]\nsandbox = 'elevated'\n" },
      { [USER]: "[features]\nelevated_windows_sandbox = true\n" },
      { [USER]: "[features]\nexperimental_windows_sandbox = false\n" },
      { [USER]: "[profiles.work.features]\nenable_experimental_windows_sandbox = true\n" },
      { [USER]: "[features]\nprefer_mxc = false\n" },
      { [SYSTEM]: "[windows]\nsandbox = 'unelevated'\n" },
      { [REQUIREMENTS]: "[features]\nelevated_windows_sandbox = true\n" },
      { [REQUIREMENTS]: "[feature_requirements]\nexperimental_windows_sandbox = true\n" },
      { [REQUIREMENTS]: "[windows]\nallowed_sandbox_implementations = ['elevated', 'unelevated']\n" },
      // Files dohc can't read or parse.
      { [USER]: "[windows\n" },
      { [REQUIREMENTS]: "[features\n" },
    ];
    for (const files of choices) {
      expect(entry(windowsRun(files), "windows.sandbox=")).toBeUndefined();
    }
    const denied = codexRunConfig({
      rootPath: "C:\\w", runId: "run_1", platform: "win32", files: { requirements: [], config: [USER] },
      readConfig: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
    });
    expect(entry(denied, "windows.sandbox=")).toBeUndefined();
    expect(entry(windowsRun({}, null), "windows.sandbox=")).toBeUndefined();
    expect(entry(codexRunConfig({ rootPath: "/w", runId: "run_1", platform: "darwin", files: NONE }), "windows.sandbox=")).toBeUndefined();
  });

  it("carries the person's network access into the run's profile", () => {
    const profile = (files: Record<string, string>) => entry(windowsRun(files), "permissions.");
    const network = "[sandbox_workspace_write]\nnetwork_access = true\n";
    expect(profile({ [USER]: network })).toMatch(/,network=\{enabled=true\}\}$/u);
    expect(profile({ [SYSTEM]: network })).toMatch(/,network=\{enabled=true\}\}$/u);
    // The user file wins over the system file.
    expect(profile({ [SYSTEM]: network, [USER]: "[sandbox_workspace_write]\nnetwork_access = false\n" })).not.toContain("network");
    expect(profile({ [SYSTEM]: network, [USER]: "[sandbox_workspace_write\n" })).not.toContain("network");
    expect(profile({ [REQUIREMENTS]: network })).not.toContain("network");
  });

  it("carries the person's temp folder exclusions into the run's profile", () => {
    const profile = (files: Record<string, string>) => entry(windowsRun(files), "permissions.");
    expect(profile({ [USER]: "[sandbox_workspace_write]\nexclude_tmpdir_env_var = true\n" }))
      .toContain("filesystem={':workspace_roots'={'.dohc'='read'},':tmpdir'='read'}");
    expect(profile({ [USER]: "[sandbox_workspace_write]\nexclude_slash_tmp = true\n" }))
      .toContain("filesystem={':workspace_roots'={'.dohc'='read'},':slash_tmp'='read'}");
    expect(profile({ [USER]: "[sandbox_workspace_write]\nwritable_roots = ['C:\\\\other']\n" }))
      .toBe(entry(windowsRun(), "permissions."));
  });

  it("reads only the person's own config files, never the workspace's", async () => {
    const root = await createTestScratch("dohc-codex-run-config-");
    const workspace = join(root, "ws");
    const home = join(root, "home");
    await mkdir(join(workspace, ".codex"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(workspace, ".codex", "config.toml"), "[sandbox_workspace_write]\nnetwork_access = true\nexclude_slash_tmp = true\n[windows]\nsandbox = 'elevated'\n");
    const { platform } = process;
    const run = () => codexRunConfig({
      rootPath: workspace, runId: "run_1", platform, files: codexConfigFiles({ ProgramData: join(root, "programdata") }, platform, home),
    });
    expect(run()).toEqual(codexRunConfig({ rootPath: workspace, runId: "run_1", platform, files: NONE }));
    // Codex resolves a relative CODEX_HOME against the workspace.
    expect(codexConfigFiles({ CODEX_HOME: ".codex" }, platform, home)).toBeNull();
    await writeFile(join(home, ".codex", "config.toml"), "[sandbox_workspace_write]\nnetwork_access = true\n");
    expect(entry(run(), "permissions.")).toContain("network={enabled=true}");
  });

  it("finds the person's config where Codex does", () => {
    expect(codexConfigFiles({ ProgramData: "D:\\ProgramData" }, "win32", "C:\\Users\\Sam")).toEqual({
      requirements: ["D:\\ProgramData\\OpenAI\\Codex\\requirements.toml"],
      config: ["D:\\ProgramData\\OpenAI\\Codex\\config.toml", "C:\\Users\\Sam\\.codex\\config.toml"],
    });
    expect(codexConfigFiles({ CODEX_HOME: "E:\\codex" }, "win32", "C:\\Users\\Sam")).toEqual({
      requirements: [REQUIREMENTS],
      config: [SYSTEM, "E:\\codex\\config.toml"],
    });
    expect(codexConfigFiles({}, "darwin", "/Users/sam")).toEqual({
      requirements: ["/etc/codex/requirements.toml"],
      config: ["/etc/codex/config.toml", "/Users/sam/.codex/config.toml", "/etc/codex/managed_config.toml"],
    });
  });
});

describe("Codex without a saved login", () => {
  const paths: CodexConfigFiles = { requirements: [REQUIREMENTS], config: [SYSTEM, USER] };
  const mayRun = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}, given: CodexConfigFiles | null = paths) =>
    codexMayRunWithoutLogin(env, given, (path) => files[path] ?? missing(path));

  it("may reach a model through CODEX_API_KEY, but not OPENAI_API_KEY", () => {
    expect(mayRun({}, { CODEX_API_KEY: "key" })).toBe(true);
    expect(mayRun({}, { OPENAI_API_KEY: "key" })).toBe(false);
    expect(mayRun({})).toBe(false);
  });

  it("may reach a model through the provider Codex picks from the person's config", () => {
    expect(mayRun({ [USER]: "model_provider = 'azure'\n" })).toBe(true);
    expect(mayRun({ [USER]: "model_provider = 'openai'\n" })).toBe(false);
    // The user config wins over the system config, and the system requirements win over both.
    expect(mayRun({ [SYSTEM]: "model_provider = 'azure'\n", [USER]: "model_provider = 'openai'\n" })).toBe(false);
    expect(mayRun({ [USER]: "model_provider = 'openai'\n", [REQUIREMENTS]: "model_provider = 'azure'\n" })).toBe(true);
    // On Unix, the managed config wins over the user config.
    const unix = codexConfigFiles({}, "linux", "/home/sam");
    const files: Record<string, string> = {
      "/home/sam/.codex/config.toml": "model_provider = 'openai'\n",
      "/etc/codex/managed_config.toml": "model_provider = 'local'\n",
    };
    expect(codexMayRunWithoutLogin({}, unix, (path) => files[path] ?? missing(path))).toBe(true);
    // dohc runs Codex without --profile.
    expect(mayRun({ [USER]: "[profiles.work]\nmodel_provider = 'azure'\n" })).toBe(false);
  });

  it("may reach a model when dohc can't read the person's config", () => {
    expect(mayRun({ [USER]: "model_provider = \n" })).toBe(true);
    expect(mayRun({}, {}, null)).toBe(true);
  });
});
