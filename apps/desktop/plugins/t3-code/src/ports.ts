import { createServer } from "node:net";

/** A currently-free loopback port from the OS. The gap between closing the
 * probe and t3 binding is a real race; the bridge retries a failed bind with
 * a fresh port rather than pretending this cannot happen. */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("The port probe returned no port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}
