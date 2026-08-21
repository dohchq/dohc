import type { SitePackageInfo } from "./sitePackage";
import {
  assertLoopbackOnlyDevServerCommand,
  packageManagerCommand,
  packageManagerValidatedScriptCommand,
  splitCommandLine,
} from "./siteRunner";

export type SitePreviewScript = "dev" | "start" | "build";

function packageManagerScriptRun(
  parsed: ReturnType<typeof splitCommandLine>,
): { manager: "npm" | "pnpm" | "yarn" | "bun"; script: string; forwardedArgs: string[] } | null {
  const [first, second, ...rest] = parsed.args;
  if (parsed.command === "npm") {
    if ((first === "run" || first === "run-script") && second) {
      // npm's own documented form for passing args through to the script:
      // `npm run <script> -- <forwardedArgs...>`. Anything after `run
      // <script>` that ISN'T this exact `--` separator is an unrecognized
      // shape, not a wrapper.
      if (rest.length === 0) return { manager: "npm", script: second, forwardedArgs: [] };
      if (rest[0] === "--") {
        return { manager: "npm", script: second, forwardedArgs: rest.slice(1) };
      }
      return null;
    }
    return null;
  }
  if (rest.length > 0) return null;
  if (
    parsed.command === "pnpm" ||
    parsed.command === "yarn" ||
    parsed.command === "bun"
  ) {
    if (first === "run" && second) {
      return { manager: parsed.command, script: second, forwardedArgs: [] };
    }
    if (first && !second) {
      return { manager: parsed.command, script: first, forwardedArgs: [] };
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
  const validated = packageManagerValidatedScriptCommand(
    run.manager,
    run.script,
    scriptBody,
    {
      pre: site.scripts[`pre${run.script}`],
      post: site.scripts[`post${run.script}`],
    },
  );
  if (run.forwardedArgs.length === 0) return validated;
  // The forwarded args land on the command dohc actually spawns, so the
  // loopback-only constraint has to see the FINAL argv — a forwarded
  // `--host 0.0.0.0` is exactly as real a bind-everywhere risk as one
  // written directly into the configured script.
  const withForwardedArgs = { command: validated.command, args: [...validated.args, ...run.forwardedArgs] };
  assertLoopbackOnlyDevServerCommand(withForwardedArgs.command, withForwardedArgs.args);
  return withForwardedArgs;
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
