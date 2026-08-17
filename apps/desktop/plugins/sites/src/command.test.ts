import { describe, expect, it } from "vitest";
import {
  assertLoopbackOnlyCommand,
  detectDevUrl,
  isLoopbackHostname,
  packageManagerCommand,
  splitCommandLine,
} from "./command";

describe("packageManagerCommand", () => {
  it("runs a script the way each package manager does", () => {
    expect(packageManagerCommand("pnpm", "dev")).toEqual({ command: "pnpm", args: ["dev"] });
    expect(packageManagerCommand("npm", "dev")).toEqual({ command: "npm", args: ["run", "dev"] });
    expect(packageManagerCommand("yarn", "dev")).toEqual({ command: "yarn", args: ["dev"] });
    expect(packageManagerCommand("bun", "dev")).toEqual({ command: "bun", args: ["run", "dev"] });
  });
});

describe("splitCommandLine", () => {
  it("splits a command into a file and its arguments", () => {
    expect(splitCommandLine("node serve.mjs --port 4000")).toEqual({
      command: "node",
      args: ["serve.mjs", "--port", "4000"],
    });
  });

  it("keeps a quoted argument whole", () => {
    expect(splitCommandLine('node "my server.mjs" --name \'the site\'')).toEqual({
      command: "node",
      args: ["my server.mjs", "--name", "the site"],
    });
  });

  it("refuses an empty command and an unterminated quote", () => {
    expect(() => splitCommandLine("   ")).toThrow(/cannot be empty/);
    expect(() => splitCommandLine('node "unfinished')).toThrow(/unterminated quote/);
  });
});

describe("assertLoopbackOnlyCommand", () => {
  it("allows a command that names no host, or names a loopback one", () => {
    expect(() => assertLoopbackOnlyCommand("pnpm", ["dev"])).not.toThrow();
    expect(() => assertLoopbackOnlyCommand("pnpm", ["dev", "--host", "127.0.0.1"])).not.toThrow();
    expect(() => assertLoopbackOnlyCommand("pnpm", ["dev", "--host=localhost"])).not.toThrow();
    expect(() => assertLoopbackOnlyCommand("pnpm", ["dev", "-H", "::1"])).not.toThrow();
  });

  it("refuses a command that publishes the site past this machine", () => {
    expect(() => assertLoopbackOnlyCommand("pnpm", ["dev", "--host", "0.0.0.0"])).toThrow(
      /must bind to a loopback host, not 0\.0\.0\.0/,
    );
    expect(() => assertLoopbackOnlyCommand("pnpm", ["dev", "--host=10.0.0.4"])).toThrow(
      /must bind to a loopback host, not 10\.0\.0\.4/,
    );
    // A bare --host with no value is vite's "every interface", and refusing it
    // has to name what it actually does.
    expect(() => assertLoopbackOnlyCommand("pnpm", ["dev", "--host"])).toThrow(
      /must bind to a loopback host, not all interfaces/,
    );
    expect(() => assertLoopbackOnlyCommand("pnpm", ["dev", "--hostname", "0.0.0.0"])).toThrow(
      /loopback/,
    );
  });

  it("refuses a host flag whatever case it is written in, in either spelling", () => {
    // The two spellings once disagreed: the inline form matched without case
    // and the separated form did not, so --HOST 0.0.0.0 ran.
    for (const args of [
      ["dev", "--HOST", "0.0.0.0"],
      ["dev", "--HOST=0.0.0.0"],
      ["dev", "--Host", "0.0.0.0"],
      ["dev", "--HostName", "0.0.0.0"],
      ["dev", "--HOSTNAME=0.0.0.0"],
    ]) {
      expect(() => assertLoopbackOnlyCommand("pnpm", args), args.join(" ")).toThrow(/loopback/);
    }
  });

  it("reads a short host flag by its own case, because -h is help", () => {
    expect(() => assertLoopbackOnlyCommand("pnpm", ["dev", "-H", "0.0.0.0"])).toThrow(/loopback/);
    expect(() => assertLoopbackOnlyCommand("pnpm", ["dev", "-h"])).not.toThrow();
  });

  it("names the command it refused, so the message says what to change", () => {
    expect(() => assertLoopbackOnlyCommand("pnpm", ["dev", "--host", "0.0.0.0"])).toThrow(
      /pnpm dev --host 0\.0\.0\.0/,
    );
  });
});

describe("isLoopbackHostname", () => {
  it("knows every spelling of this machine", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
  });

  it("knows what is not this machine", () => {
    // The hextet spelling of a mapped address (::ffff:7f00:1) is refused too.
    // No dev server takes it, and refusing is the safe direction.
    for (const host of ["0.0.0.0", "10.0.0.4", "example.com", "128.0.0.1", "::2", "::ffff:7f00:1"]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });
});

describe("detectDevUrl", () => {
  it("reads the address a dev server prints", () => {
    expect(detectDevUrl("  ➜  Local:   http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
    expect(detectDevUrl("ready on http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("reads an address a dev server coloured", () => {
    // Vite bolds the port. Matching before the escapes are stripped drops the
    // port and loads a dead preview.
    expect(detectDevUrl("Local: http://127.0.0.1:\u001B[1m5173\u001B[22m/")).toBe(
      "http://127.0.0.1:5173/",
    );
  });

  it("reports an IPv6 loopback address as one a guest can load", () => {
    expect(detectDevUrl("Local: http://[::1]:4321/")).toBe("http://127.0.0.1:4321/");
  });

  it("reports nothing for output that names no address", () => {
    expect(detectDevUrl("building for production...")).toBeNull();
    expect(detectDevUrl("https://example.com")).toBeNull();
  });
});
