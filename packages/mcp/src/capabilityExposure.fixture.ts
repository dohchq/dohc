import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDohcMcpServer } from "./server";

// Test-only transport. Listing tools performs no workspace reads or writes.
export async function advertisedCapabilityTools(shareAccess?: "view" | "comment" | "edit") {
  const server = createDohcMcpServer({ root: "/capability-snapshot", home: "/capability-home", shareAccess });
  const client = new Client({ name: "capability-snapshot", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close();
    await server.close();
  }
}
