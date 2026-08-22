import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GetSitePreviewLogsResult,
  StartSitePreviewResult,
} from "../ipc/bridgeContract";

// Every test here spawns real node children, honest work a busy machine
// stretches (#568). Measured 2026-08-03 on a 24-process load (12 runs):
// individual tests passed at up to 2.3s against vitest's 5s default test
// deadline, and the dev-server cancel completed in up to 3.3s against its
// old 2s promptness ceiling — limits inside the loaded-healthy range. The
// test deadline goes to 15s (~6x measured); the cancel ceilings and their
// widened timeout bands are documented at the tests.
vi.setConfig({ testTimeout: 15_000 });
import { createTestScratch } from "./testTemp";
import { buildOutputSiteRoot } from "./sitePackage";
import {
  assertLoopbackOnlyDevServerCommand,
  buildSite,
  BUILD_HARD_KILL_GRACE_MS,
  detectBuildOutput,
  detectDevUrl,
  packageManagerCommand,
  packageManagerValidatedScriptCommand,
  splitCommandLine,
  splitShellStatements,
  startSiteDevServer,
  startStaticSitePreview,
  WILL_QUIT_BUDGET_MS,
} from "./siteRunner";

let root: string;
const workspaceAuthority = { kind: "workspace" } as const;

beforeEach(async () => {
  root = await createTestScratch("dohc-sites-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// stopChild sends SIGKILL and returns without waiting for the kernel to
// reap the process — signal delivery and reaping are asynchronous, so
// process.kill(pid, 0) can still succeed for a short window right after
// the signal on a loaded machine. Poll for the actual death instead of
// asserting it happened immediately.
async function waitForProcessDeath(pid: number, deadlineMs = 2000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe("startStaticSitePreview", () => {
  it("serves only the mounted site's own shared-with-me subtree", async () => {
    const mountRoot = "shared-with-me/alex";
    const siteRoot = `${mountRoot}/portal`;
    await mkdir(join(root, siteRoot), { recursive: true });
    await mkdir(join(root, "shared-with-me", "blair", "portal"), { recursive: true });
    await writeFile(join(root, siteRoot, "index.html"), "<h1>Alex portal</h1>");
    await writeFile(
      join(root, "shared-with-me", "blair", "portal", "index.html"),
      "<h1>Blair portal</h1>",
    );

    const preview = await startStaticSitePreview(root, siteRoot, {
      authority: { kind: "share", mountRoot },
    });
    try {
      await expect(fetch(preview.url).then((response) => response.text()))
        .resolves.toContain("Alex portal");
    } finally {
      await preview.stop();
    }

    await expect(
      startStaticSitePreview(root, "shared-with-me/blair/portal", {
        authority: { kind: "share", mountRoot },
      }),
    ).rejects.toThrow(/own shared mount/i);
  });

  it("refuses a configured build output inside shared-with-me", async () => {
    const configuredBuildOutput = "shared-with-me/alex/site";
    await mkdir(join(root, configuredBuildOutput), { recursive: true });
    await writeFile(
      join(root, configuredBuildOutput, "index.html"),
      "<h1>Mounted build</h1>",
    );
    const site = { root: ".", configuredBuildOutput };
    const servedRoot = buildOutputSiteRoot(
      site,
      configuredBuildOutput,
    );
    const outcome = await startStaticSitePreview(root, servedRoot, {
      authority: workspaceAuthority,
    }).then(
      (preview) => ({ kind: "started" as const, preview }),
      (error: unknown) => ({ kind: "refused" as const, error }),
    );
    if (outcome.kind === "started") await outcome.preview.stop();

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(String(outcome.error)).toMatch(/shared-with-me.*cannot preview/i);
    }
  });

  it("serves a normal configured build output", async () => {
    const configuredBuildOutput = "release/site";
    await mkdir(join(root, configuredBuildOutput), { recursive: true });
    await writeFile(
      join(root, configuredBuildOutput, "index.html"),
      "<h1>Owned build</h1>",
    );
    const site = { root: ".", configuredBuildOutput };
    const servedRoot = buildOutputSiteRoot(
      site,
      configuredBuildOutput,
    );

    const preview = await startStaticSitePreview(root, servedRoot, {
      authority: workspaceAuthority,
    });
    try {
      await expect(fetch(preview.url).then((response) => response.text()))
        .resolves.toContain("Owned build");
    } finally {
      await preview.stop();
    }
  });

  it("serves a normal static website from a contained workspace folder", async () => {
    await mkdir(join(root, "report"), { recursive: true });
    await writeFile(join(root, "report", "index.html"), '<link rel="stylesheet" href="./style.css"><h1>Report</h1>');
    await writeFile(join(root, "report", "style.css"), "body { color: rgb(1, 2, 3); }");

    const preview = await startStaticSitePreview(root, "report", {
      authority: workspaceAuthority,
    });
    try {
      const html = await fetch(preview.url).then((res) => res.text());
      expect(html).toContain("<h1>Report</h1>");
      const css = await fetch(new URL("./style.css", preview.url)).then((res) => res.text());
      expect(css).toContain("rgb(1, 2, 3)");
    } finally {
      await preview.stop();
    }
  });

  it("serves a root-level workspace website", async () => {
    await writeFile(join(root, "index.html"), "<h1>Root Site</h1>");

    const preview = await startStaticSitePreview(root, ".", {
      authority: workspaceAuthority,
    });
    try {
      await expect(fetch(preview.url).then((res) => res.text())).resolves.toContain("Root Site");
    } finally {
      await preview.stop();
    }
  });

  it("does not serve a shared-with-me mount from a root-level site", async () => {
    await mkdir(join(root, "shared-with-me", "Alex"), { recursive: true });
    await writeFile(join(root, "index.html"), "<h1>Root Site</h1>");
    await writeFile(
      join(root, "shared-with-me", "Alex", "private.txt"),
      "shared private file",
    );
    await writeFile(join(root, "shared-with-me-notes.txt"), "owned sibling file");

    const preview = await startStaticSitePreview(root, ".", {
      authority: workspaceAuthority,
    });
    try {
      const shared = await fetch(
        new URL("/shared-with-me/Alex/private.txt", preview.url),
      );
      expect(shared.status).toBe(403);

      const sibling = await fetch(
        new URL("/shared-with-me-notes.txt", preview.url),
      );
      expect(sibling.status).toBe(200);
      await expect(sibling.text()).resolves.toBe("owned sibling file");
    } finally {
      await preview.stop();
    }
  });

  it("rejects traversal and missing entry files", async () => {
    await mkdir(join(root, "empty"), { recursive: true });
    await expect(
      startStaticSitePreview(root, "../escape", { authority: workspaceAuthority }),
    ).rejects.toThrow(/traversal|relative/);
    await expect(
      startStaticSitePreview(root, "empty", { authority: workspaceAuthority }),
    ).rejects.toThrow();
    await mkdir(join(root, "site"), { recursive: true });
    await writeFile(join(root, "site", "index.html"), "ok");
    await expect(startStaticSitePreview(root, "site", {
      authority: workspaceAuthority,
      entry: "../index.html",
    })).rejects.toThrow(
      /Invalid site entry/,
    );
  });

  it("never serves nested dohc metadata from a static site root", async () => {
    await mkdir(join(root, "site", "nested", ".dohc"), { recursive: true });
    await writeFile(join(root, "site", "index.html"), "public");
    await writeFile(join(root, "site", "nested", ".dohc", "secret.txt"), "secret");

    const preview = await startStaticSitePreview(root, "site", {
      authority: workspaceAuthority,
    });
    try {
      const direct = await fetch(new URL("/nested/.dohc/secret.txt", preview.url));
      expect(direct.status).toBe(403);
      const encoded = await fetch(new URL("/nested/%2edohc/secret.txt", preview.url));
      expect(encoded.status).toBe(403);
    } finally {
      await preview.stop();
    }

    await expect(
      startStaticSitePreview(root, "site", {
        authority: workspaceAuthority,
        entry: "nested/.dohc/secret.txt",
      }),
    ).rejects.toThrow(/reserved metadata path/);
  });
});

describe("package manager helpers", () => {
  it("produces script commands", () => {
    expect(packageManagerCommand("pnpm", "dev")).toEqual({ command: "pnpm", args: ["dev"] });
    expect(packageManagerCommand("npm", "build")).toEqual({ command: "npm", args: ["run", "build"] });
  });

  it("validates the visible body of package-backed dev scripts", () => {
    expect(() =>
      packageManagerValidatedScriptCommand("pnpm", "dev", "vite --host 0.0.0.0"),
    ).toThrow(/loopback/);
    expect(packageManagerValidatedScriptCommand("pnpm", "dev", "vite")).toEqual({
      command: "pnpm",
      args: ["dev"],
    });
  });

  it.each(["npm", "pnpm"] as const)(
    "validates implicit %s lifecycle hooks around a safe dev script",
    (manager) => {
      expect(() =>
        packageManagerValidatedScriptCommand(
          manager,
          "dev",
          "vite --host 127.0.0.1",
          { pre: "vite --host 0.0.0.0" },
        ),
      ).toThrow(/loopback/);
    },
  );

  it("recursively validates a shell-wrapped implicit lifecycle hook", () => {
    expect(() =>
      packageManagerValidatedScriptCommand(
        "npm",
        "dev",
        "vite --host 127.0.0.1",
        { post: "bash -lc 'vite --host 0.0.0.0'" },
      ),
    ).toThrow(/loopback/);
  });

  it("validates host flags inside visible shell-wrapped package scripts", () => {
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "sh -c 'vite --host 0.0.0.0'",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "sh -c 'vite --host 127.0.0.1'",
      ),
    ).not.toThrow();
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "BASH -c 'vite --hostname 192.168.1.1'",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "bash -lc 'vite --host 0.0.0.0'",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "bash -lc 'vite --host 127.0.0.1'",
      ),
    ).not.toThrow();
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "cmd /c 'vite --host 0.0.0.0'",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "powershell -Command 'vite --host 127.0.0.1'",
      ),
    ).not.toThrow();
  });

  it("extracts local dev server urls from common tool output", () => {
    expect(detectDevUrl("  Local:   http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(detectDevUrl("ready on http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    // A server that only listens on the IPv6 loopback reports "[::1]" —
    // rewriting it to "127.0.0.1" would point the preview at a different
    // address nothing is necessarily listening on. isLoopbackHostname
    // already accepts the bracketed IPv6 form as-is.
    expect(detectDevUrl("ready on http://[::1]:5173/app")).toBe("http://[::1]:5173/app");
    expect(detectDevUrl("ready on https://localhost:5173")).toBeNull();
    expect(detectDevUrl("deployed at https://example.com")).toBeNull();
    expect(detectDevUrl("listening on http://0.0.0.0:3000")).toBeNull();
    expect(detectDevUrl("network at http://192.168.1.1:5173")).toBeNull();
    expect(detectDevUrl("network at http://10.0.0.1:5173")).toBeNull();
    expect(detectDevUrl("ready on http://[2001:db8::1]:5173")).toBeNull();
    expect(detectDevUrl("ready on http://example.com:5173")).toBeNull();
    expect(detectDevUrl("ready on http://mysite.local:5173")).toBeNull();
    expect(detectDevUrl("ready on http://localhost.tunnel.example:5173")).toBeNull();
    // Vite with FORCE_COLOR reaching it (Playwright workers set it; user
    // shells can too) bolds the PORT with ANSI SGR sequences mid-URL — the
    // port must not be dropped (a port-less URL loads a dead preview).
    expect(
      detectDevUrl(
        "  \u001B[32m→\u001B[39m  \u001B[1mLocal\u001B[22m:   \u001B[36mhttp://127.0.0.1:\u001B[1m5173\u001B[22m/\u001B[39m",
      ),
    ).toBe("http://127.0.0.1:5173/");
  });

  it.each([
    [
      "Server ready (http://localhost:5173)",
      "http://localhost:5173",
    ],
    [
      'Local: "http://localhost:3000"',
      "http://localhost:3000",
    ],
    [
      "ready on http://localhost:5173/app.",
      "http://localhost:5173/app",
    ],
  ])("removes delimiters from a detected dev URL in %s", (output, expected) => {
    expect(detectDevUrl(output)).toBe(expected);
  });

  it("splits simple configured command strings", () => {
    expect(splitCommandLine('pnpm vite --host "127.0.0.1"')).toEqual({
      command: "pnpm",
      args: ["vite", "--host", "127.0.0.1"],
    });
    expect(() => splitCommandLine('"unterminated')).toThrow(/unterminated/);
    if (process.platform === "win32") {
      // Backslashes are Windows path separators, never shell escapes.
      expect(splitCommandLine('node "C:\\ws\\build.mjs"')).toEqual({
        command: "node",
        args: ["C:\\ws\\build.mjs"],
      });
    }
  });

  it("splits a shell body into the statements a real shell would run, not just whitespace-separated tokens", () => {
    expect(splitShellStatements("export HOST=0.0.0.0; vite")).toEqual([
      "export HOST=0.0.0.0",
      "vite",
    ]);
    expect(splitShellStatements("true && HOST=0.0.0.0 vite")).toEqual([
      "true",
      "HOST=0.0.0.0 vite",
    ]);
    expect(splitShellStatements("vite || curl http://evil")).toEqual([
      "vite",
      "curl http://evil",
    ]);
    expect(splitShellStatements("sleep 500 & echo done")).toEqual([
      "sleep 500",
      "echo done",
    ]);
    expect(splitShellStatements("vite | tee log")).toEqual(["vite", "tee log"]);
    expect(splitShellStatements("vite\nrm -rf /")).toEqual(["vite", "rm -rf /"]);
    // The same character, quoted, is an ordinary literal argument byte, not
    // a statement separator — over-splitting it would break a legitimate
    // single-statement command.
    expect(splitShellStatements('vite --define "X=1;2"')).toEqual([
      'vite --define "X=1;2"',
    ]);
  });

  it("validates every statement a package script's shell body actually runs, not just its first token", () => {
    // `export HOST=0.0.0.0; vite` runs as TWO statements under npm/pnpm's
    // own shell — the export must still be caught even though it isn't the
    // package script's first (and only recognized) command.
    expect(() =>
      packageManagerValidatedScriptCommand("pnpm", "dev", "export HOST=0.0.0.0; vite"),
    ).toThrow(/loopback/);
    // A HOST rebind hidden behind an earlier, unrelated statement must be
    // caught too — not just one glued directly onto the body's first word.
    expect(() =>
      packageManagerValidatedScriptCommand("pnpm", "dev", "true && HOST=0.0.0.0 vite"),
    ).toThrow(/loopback/);
    // A genuinely benign compound body (backgrounding a helper, chaining
    // unrelated commands, no HOST binding anywhere) must keep working —
    // refusing every compound shape outright would break real dev-server
    // wrapper scripts like this one.
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "sleep 1 & echo CHILD:$!; vite --host 127.0.0.1",
      ),
    ).not.toThrow();
  });

  it("validates every statement of a compound body hidden inside a nested shell wrapper", () => {
    // The compound structure lives INSIDE sh's own quoted body here, not at
    // the package script's top level — a distinct code path
    // (assertLoopbackOnlyDevServerCommandAtDepth's nested-shell handling)
    // from the plain package-script-body case above. An unrelated leading
    // statement ("true", not "export") hides the rebind behind an
    // ordinary "&&" — nothing about the assignment ITSELF (no glued-on
    // operator character, no "export" keyword) helps catch it; only
    // actually splitting the nested body into its own statements does.
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "sh -c 'true && HOST=0.0.0.0 vite'",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "sh -c 'export HOST=0.0.0.0; vite'",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      packageManagerValidatedScriptCommand(
        "pnpm",
        "dev",
        "sh -c 'sleep 1 & vite --host 127.0.0.1'",
      ),
    ).not.toThrow();
  });

  it("rejects dev server commands that explicitly bind outside loopback", () => {
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--host", "127.0.0.1"]),
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--host=localhost"]),
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--hostname", "::1"]),
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--host", "0.0.0.0"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--host=192.168.1.1"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("next", ["-H", "mysite.local"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", ["--host"]),
    ).toThrow(/all interfaces/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", [
        "--host",
        "127.0.0.1",
        "--host",
        "0.0.0.0",
      ]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("vite", [
        "--host",
        "127.0.0.1",
        "--host",
        "127.0.0.1",
      ]),
    ).not.toThrow();
  });

  it("gives the will-quit teardown enough budget to reach a site preview's own hard-kill deadline", () => {
    // stopChild's POSIX/Windows path waits BUILD_HARD_KILL_GRACE_MS for a
    // graceful exit before it can even issue SIGKILL — quit exiting before
    // that deadline (plus headroom for the SIGKILL round-trip itself)
    // leaves an unref'd preview process with no kill signal ever sent
    // (round-15 finding 7).
    expect(WILL_QUIT_BUDGET_MS).toBeGreaterThan(BUILD_HARD_KILL_GRACE_MS);
  });

  it("rejects a leading HOST/HOSTNAME environment assignment that binds outside loopback", () => {
    // splitCommandLine has no concept of shell env assignments — "HOST=0.0.0.0
    // node server.cjs" tokenizes as command "HOST=0.0.0.0" with args
    // ["node", "server.cjs"], which the flag-based check alone never sees.
    expect(() =>
      assertLoopbackOnlyDevServerCommand("HOST=0.0.0.0", ["node", "server.cjs"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("HOSTNAME=0.0.0.0", ["node", "server.cjs"]),
    ).toThrow(/loopback/);
    // A loopback value, or a non-host assignment entirely, is unaffected.
    expect(() =>
      assertLoopbackOnlyDevServerCommand("HOST=127.0.0.1", ["node", "server.cjs"]),
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyDevServerCommand("NODE_ENV=production", ["node", "server.cjs"]),
    ).not.toThrow();
    // Multiple leading assignments, and an assignment inside a lifecycle
    // hook's own command string, are covered too.
    expect(() =>
      assertLoopbackOnlyDevServerCommand("NODE_ENV=production", [
        "HOST=0.0.0.0",
        "node",
        "server.cjs",
      ]),
    ).toThrow(/loopback/);
  });

  it("rejects a HOST/HOSTNAME assignment passed through the env wrapper", () => {
    // GNU env's documented form: env [NAME=VALUE]... [COMMAND [ARG]...] —
    // env itself is not an assignment, so the direct-assignment scan alone
    // (which reads command+args as one leading run) never reaches "HOST="
    // here without recognizing "env" as a wrapper first.
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["HOST=0.0.0.0", "vite"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["HOSTNAME=0.0.0.0", "vite"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["HOST=127.0.0.1", "vite"]),
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["NODE_ENV=production", "vite"]),
    ).not.toThrow();
  });

  it("rejects a HOST assignment behind env's own leading OPTIONs, and refuses an unrecognized one", () => {
    // GNU env's documented form is `env [OPTION]... [NAME=VALUE]...
    // [COMMAND [ARG]...]` — its OPTIONs (-i, -u NAME, ...) can precede the
    // assignments, and the scan must recognize and skip them to still reach
    // a HOST= that follows.
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["-i", "HOST=0.0.0.0", "vite"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["--ignore-environment", "HOST=0.0.0.0", "vite"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["-u", "FOO", "HOST=0.0.0.0", "vite"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["-i", "HOST=127.0.0.1", "vite"]),
    ).not.toThrow();
    // An option this scanner does not recognize refuses outright rather
    // than silently skipping past it and missing an assignment beyond it.
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["--made-up-option", "HOST=0.0.0.0", "vite"]),
    ).toThrow(/env/);
  });

  it("refuses env -S/--split-string instead of silently skipping its embedded assignment", () => {
    // GNU env's -S/--split-string re-splits ITS OWN payload into further
    // OPTIONs, NAME=VALUE assignments, and the command, using env's own
    // splitting rules (not shell quoting) — `env -S 'HOST=0.0.0.0 vite'`
    // hides a real HOST assignment from a scanner that treats -S as an
    // opaque value-carrying option the way -u/-C are.
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["-S", "HOST=0.0.0.0 vite"]),
    ).toThrow(/env/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["--split-string=HOST=0.0.0.0 vite"]),
    ).toThrow(/env/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["--split-string", "HOST=0.0.0.0 vite"]),
    ).toThrow(/env/);
  });

  it("accepts env's -- end-of-options marker and keeps scanning the assignment after it", () => {
    // GNU env's synopsis is `env [OPTION]... [-] [NAME=VALUE]...
    // [COMMAND [ARG]...]` — "--" is the standard end-of-options marker
    // (distinct from a bare "-", which resets the environment); a safe
    // `env -- HOST=127.0.0.1 vite` must not be rejected as an unrecognized
    // option, or a legitimate dev command is refused outright.
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["--", "HOST=0.0.0.0", "vite"]),
    ).toThrow(/loopback/);
    expect(() =>
      assertLoopbackOnlyDevServerCommand("env", ["--", "HOST=127.0.0.1", "vite"]),
    ).not.toThrow();
  });
});

describe("startSiteDevServer", () => {
  it.runIf(process.platform !== "win32")(
    "stops descendants after the shell wrapper exits",
    async () => {
      await mkdir(join(root, "site"), { recursive: true });
      const handle = await startSiteDevServer({
        workspaceRoot: root,
        siteRoot: "site",
        command: "sh",
        args: [
          "-c",
          "sleep 500 & child=$!; echo CHILD:$child; echo 'Local: http://127.0.0.1:43210'; wait",
        ],
        readyTimeoutMs: 5000,
      });
      const childLog = handle.logs().find((entry) => entry.text.includes("CHILD:"));
      const descendantPid = Number(/CHILD:(\d+)/.exec(childLog?.text ?? "")?.[1]);
      expect(descendantPid).toBeGreaterThan(0);

      try {
        await handle.stop();
        expect(await waitForProcessDeath(descendantPid)).toBe(true);
      } finally {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The fixed teardown already removed it.
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "stops a descendant that survives after the wrapper itself has already exited",
    async () => {
      await mkdir(join(root, "site"), { recursive: true });
      // No `wait` — the shell prints the ready URL and its background
      // child's pid, then exits immediately, well before stop() is ever
      // called. The descendant keeps running as an orphan unless it was
      // captured while the wrapper was still alive.
      const handle = await startSiteDevServer({
        workspaceRoot: root,
        siteRoot: "site",
        command: "sh",
        args: [
          "-c",
          // The trailing sleep keeps the wrapper alive long enough (with a
          // 20ms poll interval, comfortably many ticks) for the descendant
          // poll to capture the backgrounded pid at least once BEFORE the
          // wrapper exits on its own — the exact condition this pin proves,
          // not an arbitrary wait for stop() to happen to run late enough.
          "sleep 500 & child=$!; echo CHILD:$child; echo 'Local: http://127.0.0.1:43212'; sleep 0.3",
        ],
        readyTimeoutMs: 5000,
        descendantCaptureIntervalMs: 20,
      });
      const childLog = handle.logs().find((entry) => entry.text.includes("CHILD:"));
      const descendantPid = Number(/CHILD:(\d+)/.exec(childLog?.text ?? "")?.[1]);
      expect(descendantPid).toBeGreaterThan(0);

      // Wait for the wrapper to have actually exited on its own before
      // calling stop() — the scenario this pin exercises.
      await new Promise<void>((resolve) => handle.onExit(resolve));

      try {
        await handle.stop();
        expect(await waitForProcessDeath(descendantPid)).toBe(true);
      } finally {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The fixed teardown already removed it.
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "captures a descendant that backgrounds and exits well inside the FIRST poll interval",
    async () => {
      await mkdir(join(root, "site"), { recursive: true });
      // The poll interval is set far longer than this whole test takes, so
      // the descendant can ONLY be captured by an immediate/near-immediate
      // snapshot, never by the interval's own first tick. A brief real
      // delay (well under the OLD 5s default, comfortably over one `ps`
      // round-trip) keeps this realistic — the descendant tree walk itself
      // takes real wall-clock time (spawning `ps`, reading /proc), so a
      // wrapper that exits in literally zero time is an unfixable race
      // no synchronous snapshot can win (the same residual #857 accepted);
      // this pin proves the fix closes the gap from 5s down to tens of
      // milliseconds, not that it closes it to zero.
      const handle = await startSiteDevServer({
        workspaceRoot: root,
        siteRoot: "site",
        command: "sh",
        args: [
          "-c",
          "sleep 500 & child=$!; echo CHILD:$child; echo 'Local: http://127.0.0.1:43213'; sleep 0.05",
        ],
        readyTimeoutMs: 5000,
        descendantCaptureIntervalMs: 60_000,
      });
      const childLog = handle.logs().find((entry) => entry.text.includes("CHILD:"));
      const descendantPid = Number(/CHILD:(\d+)/.exec(childLog?.text ?? "")?.[1]);
      expect(descendantPid).toBeGreaterThan(0);

      await new Promise<void>((resolve) => handle.onExit(resolve));

      try {
        await handle.stop();
        expect(await waitForProcessDeath(descendantPid)).toBe(true);
      } finally {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The fixed teardown already removed it.
        }
      }
    },
  );

  it("reports when a ready dev server exits on its own", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const handle = await startSiteDevServer({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: [
        "-e",
        "console.log('Local: http://127.0.0.1:43210'); process.exit(0)",
      ],
      readyTimeoutMs: 5000,
    });

    // Subscribe after the process is already down. Main can be busy between
    // receiving the ready URL and storing the handle, so late subscribers
    // must still receive the exit.
    await new Promise<void>((resolve) => handle.onExit(resolve));
    await new Promise<void>((resolve) => handle.onExit(resolve));
  });

  it("waits for a local URL, buffers logs, and stops the child process", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const handle = await startSiteDevServer({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: [
        "-e",
        "console.log('Local: http://127.0.0.1:43210'); setInterval(() => {}, 1000)",
      ],
      readyTimeoutMs: 5000,
    });
    try {
      expect(handle.url).toBe("http://127.0.0.1:43210");
      expect(handle.logs().some((entry) => entry.text.includes("Local:"))).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it("keeps oversized log lines inside the preview IPC contract", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const handle = await startSiteDevServer({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: [
        "-e",
        [
          'console.log("x".repeat(10_001));',
          "console.log('Local: http://127.0.0.1:43210');",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      readyTimeoutMs: 5000,
    });
    try {
      const logs = handle.logs();
      const parseResults = {
        immediate: StartSitePreviewResult.safeParse({
          siteRoot: "site",
          mode: "dev",
          url: handle.url,
          logs,
          exited: false,
        }).success,
        later: GetSitePreviewLogsResult.safeParse({
          logs,
          exited: false,
        }).success,
      };
      expect(parseResults).toEqual({ immediate: true, later: true });

      const oversized = logs.find((entry) => entry.text.startsWith("x"));
      expect(oversized?.text.length).toBeLessThanOrEqual(10_000);
      expect(oversized?.text).toContain("[truncated]");
    } finally {
      await handle.stop();
    }
  });

  it("detects a local URL split across stdout chunks", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const handle = await startSiteDevServer({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdout.write('Local: http://local');",
          "setTimeout(() => process.stdout.write('host:5173/\\n'), 100);",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      readyTimeoutMs: 750,
    });
    try {
      expect(handle.url).toBe("http://localhost:5173/");
    } finally {
      await handle.stop();
    }
  });

  it("does not reject the ready-timeout until the child is fully stopped", async () => {
    // Regression: the ready-timeout used to `void stopChild(child)` and reject
    // immediately, so a caller could observe the failure and delete/switch the
    // workspace while the dev server was still alive holding the site dir. The
    // reject must now wait for stopChild to complete. A child that delays its
    // exit on SIGTERM makes the ordering observable: with the await in place
    // the rejection cannot arrive before that delay has elapsed.
    await mkdir(join(root, "site"), { recursive: true });
    const pidFile = join(root, "site", "dev.pid");
    const readyTimeoutMs = 150;
    const sigtermExitDelayMs = 400;
    const script = [
      `process.on("SIGTERM", () => { setTimeout(() => process.exit(0), ${sigtermExitDelayMs}); });`,
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const startedAt = Date.now();
    await expect(
      startSiteDevServer({
        workspaceRoot: root,
        siteRoot: "site",
        command: process.execPath,
        args: ["-e", script],
        readyTimeoutMs,
      }),
    ).rejects.toThrow(/did not report a local URL/);
    const elapsed = Date.now() - startedAt;

    // Reject waited for the delayed exit; without the fix it fires at ~150ms.
    // On win32 stopChild reaches killChildTreeWin32 (taskkill /T /F) before
    // it ever sends SIGTERM, so the child dies immediately and the delay is
    // unobservable; the pid liveness check below still catches the regression
    // (verified: re-injecting `void stopChild` fails it 5/5 on Windows).
    if (process.platform !== "win32") {
      expect(elapsed).toBeGreaterThanOrEqual(readyTimeoutMs + sigtermExitDelayMs - 100);
    }

    // And the child is confirmed down by the time the rejection surfaces.
    // The child writes its pid file asynchronously after spawn, and nothing in
    // the reject path waits for it — on a loaded machine the read below can
    // outrun the child and fail ENOENT. Wait for the file the assertion needs.
    await expect
      .poll(() => existsSync(pidFile), { timeout: 10_000 })
      .toBe(true);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("fails when the child exits before reporting a URL", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    await expect(
      startSiteDevServer({
        workspaceRoot: root,
        siteRoot: "site",
        command: process.execPath,
        args: ["-e", "console.error('nope'); process.exit(2)"],
        readyTimeoutMs: 5000,
      }),
    ).rejects.toThrow(/exited before it was ready/);
  });

  it("cancels an in-flight dev server start", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const controller = new AbortController();
    const startedAt = Date.now();
    // The ceiling proves the abort drove the rejection, not the ready
    // timeout. Honest cancels measured up to 3.3s on a 24-process load
    // (#568), so the old 5000/2000 band held no room for both margins:
    // 30_000/10_000 keeps 3x above the measured cancel and 3x below the
    // ready timeout.
    const starting = startSiteDevServer({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      readyTimeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    await expect(starting).rejects.toThrow(/cancelled/);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

describe("buildSite", () => {
  it("runs a build command and detects the output directory", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const result = await buildSite({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/index.html','built'); console.log('built ok')",
      ],
      timeoutMs: 10000,
    });
    expect(result.ok).toBe(true);
    expect(result.outputPath).toBe(join(root, "site", "dist"));
    expect(result.logs.some((entry) => entry.text.includes("built ok"))).toBe(true);
    expect(await readFile(join(root, "site", "dist", "index.html"), "utf8")).toBe("built");
  });

  it.runIf(process.platform !== "win32")(
    "stops a descendant a successful build wrapper backgrounds and leaves behind",
    async () => {
      await mkdir(join(root, "site"), { recursive: true });
      const result = await buildSite({
        workspaceRoot: root,
        siteRoot: "site",
        command: "sh",
        args: [
          "-c",
          // Backgrounds a helper, writes the configured output, and exits
          // successfully — the exact "completed wrapper leaves processes
          // behind" scenario this pin proves gets torn down. A brief real
          // delay (well under buildSite's own descendant-poll interval)
          // keeps this realistic — the descendant tree walk itself takes
          // real wall-clock time, so a wrapper that exits in literally
          // zero time is an unfixable race no synchronous snapshot can
          // win (the same residual round 17/#857 accepted).
          "sleep 500 & echo CHILD:$! ; mkdir -p dist && echo built > dist/index.html; sleep 0.1",
        ],
        timeoutMs: 10000,
      });
      expect(result.ok).toBe(true);
      const childLog = result.logs.find((entry) => entry.text.includes("CHILD:"));
      const descendantPid = Number(/CHILD:(\d+)/.exec(childLog?.text ?? "")?.[1]);
      expect(descendantPid).toBeGreaterThan(0);

      try {
        expect(await waitForProcessDeath(descendantPid)).toBe(true);
      } finally {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The fixed teardown already removed it.
        }
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "stops a descendant a successful build wrapper backgrounds and leaves behind (win32)",
    async () => {
      // Windows has no POSIX fork/reparent-to-init: a process Start-Process
      // launches independently of any job object keeps running, untouched,
      // once its own creator (the powershell.exe wrapper `child` here) has
      // already exited — taskkill /PID <dead wrapper> /T then has nothing
      // live to walk from, exactly the gap stopChild's win32 branch closes
      // by reaching each periodically-captured descendant pid directly.
      await mkdir(join(root, "site"), { recursive: true });
      const script = [
        "$psExe = Join-Path $PSHOME 'powershell.exe'",
        "$proc = Start-Process -FilePath $psExe -ArgumentList " +
          "'-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60' " +
          "-PassThru -WindowStyle Hidden",
        "Write-Output ('CHILD:' + $proc.Id)",
        // Keeps the wrapper alive long enough for the immediate post-spawn
        // descendant snapshot (a second powershell.exe round trip reading
        // Win32_Process) to land before this wrapper exits on its own —
        // buildSite has no descendant-poll-interval override, so that
        // immediate snapshot is the only capture this scenario can rely on.
        "Start-Sleep -Milliseconds 2000",
      ].join("; ");
      const result = await buildSite({
        workspaceRoot: root,
        siteRoot: "site",
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", script],
        timeoutMs: 15000,
      });
      expect(result.exitCode).toBe(0);
      const childLog = result.logs.find((entry) => entry.text.includes("CHILD:"));
      const descendantPid = Number(/CHILD:(\d+)/.exec(childLog?.text ?? "")?.[1]);
      expect(descendantPid).toBeGreaterThan(0);

      try {
        expect(await waitForProcessDeath(descendantPid, 5000)).toBe(true);
      } finally {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The fixed teardown already removed it.
        }
      }
    },
    20_000,
  );

  it("reports failed builds without stale output", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const result = await buildSite({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: ["-e", "console.error('broken build'); process.exit(3)"],
      timeoutMs: 10000,
    });
    expect(result.ok).toBe(false);
    expect(result.outputPath).toBeNull();
    expect(result.exitCode).toBe(3);
    expect(result.logs.some((entry) => entry.text.includes("broken build"))).toBe(true);
  });

  it("cancels an in-flight build instead of waiting for its timeout", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const controller = new AbortController();
    const startedAt = Date.now();
    // Same band as the dev-server cancel above (#568): the ceiling proves
    // the abort ended the build, not the build timeout, with 3x margin to
    // the measured loaded cancel on one side and to the timeout on the
    // other.
    const building = buildSite({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    const result = await building;
    expect(result.ok).toBe(false);
    expect(result.logs.some((entry) => entry.text.includes("Build cancelled"))).toBe(
      true,
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("reports build timeouts with the resolved timeout", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const result = await buildSite({
      workspaceRoot: root,
      siteRoot: "site",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.logs.some((entry) => entry.text.includes("Build timed out after 100ms."))).toBe(
      true,
    );
  });

  it("detects configured and conventional build outputs", async () => {
    await mkdir(join(root, "site", "custom"), { recursive: true });
    await writeFile(join(root, "site", "custom", "index.html"), "<h1>Custom</h1>");
    expect(await detectBuildOutput(join(root, "site"), "custom")).toBe(join(root, "site", "custom"));
    await mkdir(join(root, "outside"), { recursive: true });
    expect(await detectBuildOutput(join(root, "site"), "../outside")).toBeNull();
    expect(await detectBuildOutput(join(root, "site"))).toBeNull();
    await mkdir(join(root, "site", "out"), { recursive: true });
    // A directory alone isn't a servable build output — nothing was
    // actually built there yet.
    expect(await detectBuildOutput(join(root, "site"))).toBeNull();
    await writeFile(join(root, "site", "out", "index.html"), "<h1>Out</h1>");
    expect(await detectBuildOutput(join(root, "site"))).toBe(join(root, "site", "out"));
    expect(existsSync(join(root, "site", "out"))).toBe(true);
  });

  // chmod's read bit is only meaningfully enforced by POSIX filesystems —
  // on Windows it toggles the read-only (write) attribute and never denies
  // a read, so this scenario has no faithful equivalent there.
  it.runIf(process.platform !== "win32")(
    "does not report a build output whose index.html exists but cannot be read",
    async () => {
      await mkdir(join(root, "site", "dist"), { recursive: true });
      const indexPath = join(root, "site", "dist", "index.html");
      await writeFile(indexPath, "<h1>Built</h1>");
      await chmod(indexPath, 0o000);
      try {
        expect(await detectBuildOutput(join(root, "site"))).toBeNull();
      } finally {
        await chmod(indexPath, 0o600);
      }
    },
  );
});
