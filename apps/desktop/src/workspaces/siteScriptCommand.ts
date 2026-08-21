import type { SitePackageInfo } from "./sitePackage";
import {
  assertLoopbackOnlyDevServerCommand,
  packageManagerCommand,
  packageManagerValidatedScriptCommand,
  splitCommandLine,
} from "./siteRunner";

export type SitePreviewScript = "dev" | "start" | "build";

const KNOWN_PACKAGE_MANAGER_COMMANDS: ReadonlySet<string> = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
]);

// npm's own documented boolean options for `run`/`run-script`, deliberately
// excluding any option that takes a value (e.g. --script-shell) — a
// value-taking option could redirect execution somewhere dohc never
// validates, so it's left unrecognized rather than allowlisted.
const NPM_RUN_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  "--if-present",
  "--ignore-scripts",
  "--silent",
  "-s",
  "--foreground-scripts",
]);

// `npm run [options] <script> [options] [-- <forwardedArgs...>]` — options
// can land either between `run` and the script name or after it.
function npmRunScriptResult(
  args: string[],
): { script: string; forwardedArgs: string[] } | null {
  let i = 0;
  while (i < args.length && NPM_RUN_BOOLEAN_OPTIONS.has(args[i])) i++;
  const script = args[i];
  if (!script) return null;
  i++;
  while (i < args.length && NPM_RUN_BOOLEAN_OPTIONS.has(args[i])) i++;
  if (i === args.length) return { script, forwardedArgs: [] };
  if (args[i] === "--") return { script, forwardedArgs: args.slice(i + 1) };
  return null;
}

function packageManagerScriptRun(
  parsed: ReturnType<typeof splitCommandLine>,
): { manager: "npm" | "pnpm" | "yarn" | "bun"; script: string; forwardedArgs: string[] } | null {
  if (parsed.command === "npm") {
    const [first, ...rest] = parsed.args;
    if (first !== "run" && first !== "run-script") return null;
    const run = npmRunScriptResult(rest);
    return run ? { manager: "npm", script: run.script, forwardedArgs: run.forwardedArgs } : null;
  }
  const [first, second, ...rest] = parsed.args;
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
    const validated = validatedPackageManagerRun(site, parsed);
    if (validated) return validated;
    // A known package manager MUST resolve to a validated script run — the
    // uninspected literal-command fallback below is only for commands that
    // aren't a package manager at all (e.g. a bare `vite --host ...`).
    // Falling through here would let an unrecognized wrapper shape (like
    // `npm run dev --if-present` before this fix) execute unvalidated.
    if (KNOWN_PACKAGE_MANAGER_COMMANDS.has(parsed.command)) {
      throw new Error(
        `This site's configured ${script} command invokes ${parsed.command} in a shape dohc does not recognize as a script-run wrapper: ${configuredCommand}`,
      );
    }
    return parsed;
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
