import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { JsonRpcTransport } from "./JsonRpcTransport";

const fakeAgent = fileURLToPath(
  new URL("../../e2e/fixtures/fakeAgentProcess.mjs", import.meta.url),
);
const transports: JsonRpcTransport[] = [];

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function expectDisposeToExit(detached?: true): Promise<void> {
  let exited = false;
  const transport = JsonRpcTransport.spawn({
    command: process.execPath,
    args: [fakeAgent, "acp"],
    cwd: await createTestScratch("dohc-json-rpc-transport-"),
    ...(detached ? { detached } : {}),
    onExit: () => {
      exited = true;
    },
  });
  transports.push(transport);
  await expect(transport.request("initialize")).resolves.toEqual({
    protocolVersion: 1,
  });

  await transport.dispose();
  await waitFor(() => exited, "Disposed JSON-RPC child did not exit.");
}

describe("JsonRpcTransport disposal", () => {
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.dispose()));
  });

  it("keeps the direct-child disposal behavior when detached is omitted", async () => {
    await expectDisposeToExit();
  });

  it("terminates a detached child on the current platform", async () => {
    await expectDisposeToExit(true);
  });
});
