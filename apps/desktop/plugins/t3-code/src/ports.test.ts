import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { allocateLoopbackPort } from "./ports";

describe("allocateLoopbackPort", () => {
  it("returns a port that can actually be bound on loopback", async () => {
    const port = await allocateLoopbackPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
    });
  });
});
