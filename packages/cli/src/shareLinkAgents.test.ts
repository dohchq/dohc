import { describe, expect, it, vi } from "vitest";
import { executeCli } from "./index";
import { CLI_PROTOCOL_VERSION, cliRequestSchema, parseCliResult } from "./protocol";
import { parseCliArguments } from "./args";

const link = { shareId: "share", grantId: "grant" };
const agent = { connectionId: "connection", reportedName: "Claude", connectedAtMs: 0, lastActionAtMs: 1_000 };
const run = (argv: string[], reply: unknown) => {
  const request = vi.fn(async () => reply);
  return { request, result: executeCli({ argv, cwd: "/workspace", env: {}, request }) };
};

describe("share agents", () => {
  it("sends only the link coordinates, the cursor, and the local cwd", async () => {
    const parsed = parseCliArguments(["share", "agents", "share", "grant"], {});
    expect(parsed).toMatchObject({ verb: "shareAgents", ...link });
    expect(parsed).not.toHaveProperty("cursor");
    const { request, result } = run(["share", "agents", "share", "grant", "--cursor", "next"], { agents: [], nextCursor: null });
    expect((await result).exitCode).toBe(0);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ verb: "shareAgents", args: { ...link, cursor: "next", cwd: expect.any(String), actor: "human" } }));
  });
  it("leaves the cursor out when none is given", async () => {
    const { request, result } = run(["share", "agents", "share", "grant"], { agents: [], nextCursor: null });
    await result;
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ args: { ...link, cwd: expect.any(String), actor: "human" } }));
  });
  it.each([{ operands: [] }, { operands: ["share"] }, { operands: ["share", "grant", "extra"] }])("refuses missing or extra operands %j", ({ operands }) => {
    expect(() => parseCliArguments(["share", "agents", ...operands], {})).toThrow();
  });
  it.each(["workspaceId", "ownerUserId", "userId", "credentials", "relayUrl"])("refuses caller-supplied %s at socket parsing", key => {
    expect(cliRequestSchema.safeParse({ protocolVersion: CLI_PROTOCOL_VERSION, token: "a".repeat(64), verb: "shareAgents",
      args: { ...link, cwd: "/workspace", actor: "agent", [key]: "other" } }).success).toBe(false);
  });
  it("prints each agent on one line, and the cursor for the next page", async () => {
    const { result } = run(["share", "agents", "share", "grant"], {
      agents: [agent, { connectionId: "quiet", reportedName: null, connectedAtMs: 0, lastActionAtMs: null }], nextCursor: "next",
    });
    expect(await result).toEqual({ exitCode: 0, stderr: "", stdout: [
      "connection · reported name \"Claude\" · signed in 1970-01-01T00:00:00.000Z · last action 1970-01-01T00:00:01.000Z",
      "quiet · no reported name · signed in 1970-01-01T00:00:00.000Z · no action yet",
      "More agents; use --cursor next",
      "",
    ].join("\n") });
  });
  it("says so when no agent is connected", async () => {
    expect((await run(["share", "agents", "share", "grant"], { agents: [], nextCursor: null }).result).stdout)
      .toBe("No agent is connected through this link.\n");
  });
  it("prints a reported name as its code points when it could move, recolor, or reorder the terminal", async () => {
    const reportedName = "\u001b[31mEvil\nOwner\u202e\u2028\"\\";
    const { stdout } = await run(["share", "agents", "share", "grant"], { agents: [{ ...agent, reportedName }], nextCursor: null }).result;
    expect(stdout).toContain(String.raw`reported name "\u{1b}[31mEvil\u{a}Owner\u{202e}\u{2028}\"\\"`);
    expect(stdout).not.toMatch(/[\u001b\u202e\u2028]/);
    expect(stdout.split("\n")).toHaveLength(2);
  });
  it("prints the longest name the relay may report in full, and refuses a longer one", async () => {
    const longest = "a".repeat(100);
    expect((await run(["share", "agents", "share", "grant"], { agents: [{ ...agent, reportedName: longest }], nextCursor: null }).result).stdout)
      .toContain(`reported name "${longest}"`);
    expect(await run(["share", "agents", "share", "grant"], { agents: [{ ...agent, reportedName: `${longest}a` }], nextCursor: null }).result)
      .toEqual({ exitCode: 1, stdout: "", stderr: "dohc: desktop app returned an invalid response\n" });
  });
  it("prints the page as JSON with --json", async () => {
    const { stdout } = await run(["share", "agents", "share", "grant", "--json"], { agents: [agent], nextCursor: null }).result;
    expect(JSON.parse(stdout)).toEqual({ schemaVersion: expect.any(Number), agents: [agent], nextCursor: null });
  });
  it("pins the page to the IPC contract", () => {
    expect(parseCliResult("shareAgents", { agents: [{ ...agent, userId: "user" }], nextCursor: null }).agents[0]).not.toHaveProperty("userId");
    expect(() => parseCliResult("shareAgents", { agents: [], nextCursor: null, workspaceId: "workspace" })).toThrow();
    expect(() => parseCliResult("shareAgents", { agents: Array.from({ length: 51 }, () => agent), nextCursor: null })).toThrow();
  });
  it("exits 1 with the desktop's refusal", async () => {
    const request = vi.fn(async () => { throw new Error("Open the owning workspace to list a link's agents."); });
    expect(await executeCli({ argv: ["share", "agents", "share", "grant"], cwd: "/workspace", env: {}, request }))
      .toEqual({ exitCode: 1, stdout: "", stderr: "dohc: Open the owning workspace to list a link's agents.\n" });
  });
});

describe("share disconnect", () => {
  const input = { ...link, connectionId: "connection" };
  it("sends only the link coordinates, the connection id, and the local cwd", async () => {
    expect(parseCliArguments(["share", "disconnect", "share", "grant", "connection"], {})).toMatchObject({ verb: "shareDisconnect", ...input });
    const { request, result } = run(["share", "disconnect", "share", "grant", "connection"], { connectionId: "connection" });
    expect(await result).toEqual({ exitCode: 0, stdout: "Disconnected connection\n", stderr: "" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ verb: "shareDisconnect", args: { ...input, cwd: expect.any(String), actor: "human" } }));
  });
  it.each([{ operands: [] }, { operands: ["share", "grant"] }, { operands: ["share", "grant", "connection", "extra"] }])("refuses missing or extra operands %j", ({ operands }) => {
    expect(() => parseCliArguments(["share", "disconnect", ...operands], {})).toThrow();
  });
  it.each(["workspaceId", "ownerUserId", "userId", "credentials", "relayUrl"])("refuses caller-supplied %s at socket parsing", key => {
    expect(cliRequestSchema.safeParse({ protocolVersion: CLI_PROTOCOL_VERSION, token: "a".repeat(64), verb: "shareDisconnect",
      args: { ...input, cwd: "/workspace", actor: "agent", [key]: "other" } }).success).toBe(false);
  });
  it("prints the result as JSON with --json, and pins it to the IPC contract", async () => {
    const { stdout } = await run(["share", "disconnect", "share", "grant", "connection", "--json"], { connectionId: "connection" }).result;
    expect(JSON.parse(stdout)).toEqual({ schemaVersion: expect.any(Number), connectionId: "connection" });
    expect(() => parseCliResult("shareDisconnect", { connectionId: "connection", agent: {} })).toThrow();
  });
});
