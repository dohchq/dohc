import type { SitePackageInfo } from "./sitePackage";
import {
  packageManagerCommand,
  packageManagerValidatedScriptCommand,
  splitCommandLine,
} from "./siteRunner";

export type SitePreviewScript = "dev" | "start" | "build";

function packageManagerScriptRun(
  parsed: ReturnType<typeof splitCommandLine>,
): { manager: "npm" | "pnpm" | "yarn"; script: string } | null {
  const [first, second, ...rest] = parsed.args;
  if (rest.length > 0) return null;
  if (parsed.command === "npm") {
    if ((first === "run" || first === "run-script") && second) {
      return { manager: "npm", script: second };
    }
    return null;
  }
  if (parsed.command === "pnpm" || parsed.command === "yarn") {
    if (first === "run" && second) {
      return { manager: parsed.command, script: second };
    }
    if (first && !second) {
      return { manager: parsed.command, script: first };
    }
  }
  return null;
}

function validatedPackageManagerRun(
  site: SitePackageInfo,
  parsed: ReturnType<typeof splitCommandLine>,
): ReturnType<typeof packageManagerCommand> | null {
  const run = packageManagerScriptRun(parsed);
  if (!run) return null;
  if (!site.packagePath) {
    throw new Error(
      `Site has no package.json to run ${run.script} via ${run.manager}: ${site.root}`,
    );
  }
  const scriptBody = site.scripts[run.script];
  if (!scriptBody) {
    throw new Error(
      `Site has no ${run.script} script to run via ${run.manager}: ${site.root}`,
    );
  }
  return packageManagerValidatedScriptCommand(
    run.manager,
    run.script,
    scriptBody,
    {
      pre: site.scripts[`pre${run.script}`],
      post: site.scripts[`post${run.script}`],
    },
  );
}

export function commandForSiteScript(
  site: SitePackageInfo,
  script: SitePreviewScript,
): { command: string; args: string[] } {
  const configuredCommand = site.configuredScripts[script];
  if (configuredCommand) {
    const parsed = splitCommandLine(configuredCommand);
    return validatedPackageManagerRun(site, parsed) ?? parsed;
  }
  const configured = site.scripts[script];
  if (!configured) throw new Error(`Site has no ${script} script: ${site.root}`);
  if (site.packagePath) {
    if (script === "dev" || script === "start") {
      return packageManagerValidatedScriptCommand(
        site.packageManager ?? "npm",
        script,
        configured,
        script === "dev"
          ? { pre: site.scripts.predev, post: site.scripts.postdev }
          : { pre: site.scripts.prestart, post: site.scripts.poststart },
      );
    }
    return packageManagerCommand(site.packageManager ?? "npm", script);
  }
  return splitCommandLine(configured);
}
