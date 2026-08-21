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
// can land either between `run` and the script name or after it. They're
// collected (not discarded) — `--ignore-scripts` changes what actually
// RUNS, so dropping it from the rewritten command would run hooks the user
// explicitly suppressed.
function npmRunScriptResult(
  args: string[],
): { script: string; options: string[]; forwardedArgs: string[] } | null {
  const options: string[] = [];
  let i = 0;
  while (i < args.length && NPM_RUN_BOOLEAN_OPTIONS.has(args[i])) options.push(args[i++]);
  const script = args[i];
  if (!script) return null;
  i++;
  while (i < args.length && NPM_RUN_BOOLEAN_OPTIONS.has(args[i])) options.push(args[i++]);
  if (i === args.length) return { script, options, forwardedArgs: [] };
  if (args[i] === "--") return { script, options, forwardedArgs: args.slice(i + 1) };
  return null;
}

function packageManagerScriptRun(
  parsed: ReturnType<typeof splitCommandLine>,
): { manager: "npm" | "pnpm" | "yarn" | "bun"; script: string; options: string[]; forwardedArgs: string[] } | null {
  if (parsed.command === "npm") {
    const [first, ...rest] = parsed.args;
    if (first !== "run" && first !== "run-script") return null;
    const run = npmRunScriptResult(rest);
    return run
      ? { manager: "npm", script: run.script, options: run.options, forwardedArgs: run.forwardedArgs }
      : null;
  }
  const [first, second, ...rest] = parsed.args;
  if (rest.length > 0) return null;
  if (
    parsed.command === "pnpm" ||
    parsed.command === "yarn" ||
    parsed.command === "bun"
  ) {
    if (first === "run" && second) {
      return { manager: parsed.command, script: second, options: [], forwardedArgs: [] };
    }
    if (first && !second) {
      return { manager: parsed.command, script: first, options: [], forwardedArgs: [] };
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
  const extraArgs = [...run.options, ...run.forwardedArgs];
  if (extraArgs.length === 0) return validated;
  // Recognized options and forwarded args both have to land on the command
  // dohc actually spawns — dropping `--ignore-scripts` here would run
  // pre/post hooks the user explicitly suppressed, and a forwarded
  // `--host 0.0.0.0` is exactly as real a bind-everywhere risk as one
  // written directly into the configured script. The loopback-only
  // constraint has to see this FINAL argv.
  const withExtraArgs = { command: validated.command, args: [...validated.args, ...extraArgs] };
  assertLoopbackOnlyDevServerCommand(withExtraArgs.command, withExtraArgs.args);
  return withExtraArgs;
}

// The literal-command paths below (a non-package-manager configured
// command, or a scripts-only site with no package.json at all) still need
// the loopback-only constraint applied directly — a build command is as
// real a listen-on-all-interfaces risk for its whole (longer) budget as a
// dev command is, and buildSite's own spawn path does not validate this
// itself.
function validatedLiteralCommand(
  command: ReturnType<typeof splitCommandLine>,
): ReturnType<typeof splitCommandLine> {
  assertLoopbackOnlyDevServerCommand(command.command, command.args);
  return command;
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
    return validatedLiteralCommand(parsed);
  }
  const configured = site.scripts[script];
  if (!configured) throw new Error(`Site has no ${script} script: ${site.root}`);
  if (site.packagePath) {
    // dev/start/build all validate the same way — a package.json build
    // script (or its pre/post hooks) is exactly as capable of binding
    // outside loopback as a dev script is, for as long as buildSite's own
    // (longer) timeout allows it to keep listening.
    return packageManagerValidatedScriptCommand(
      site.packageManager ?? "npm",
      script,
      configured,
      { pre: site.scripts[`pre${script}`], post: site.scripts[`post${script}`] },
    );
  }
  return validatedLiteralCommand(splitCommandLine(configured));
}
