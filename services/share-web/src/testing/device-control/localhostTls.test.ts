import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ensureLocalhostTls } from "./localhostTls.js";

it("keeps the first published TLS pair stable while other callers mint", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-localhost-tls-"));
  try {
    const observations = await Promise.all(Array.from({ length: 4 }, async () => {
      const paths = await ensureLocalhostTls(root);
      return { ...paths, trusted: readFileSync(paths.certificate) };
    }));
    const first = observations[0];
    const cert = await readFile(first.certificate), key = await readFile(first.key);
    const fingerprint = new X509Certificate(cert).fingerprint256;
    expect(observations.map(row => new X509Certificate(row.trusted).fingerprint256)).toEqual(Array(4).fill(fingerprint));
    const server = createServer({ cert, key }, (_request, response) => response.end("ready"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const port = (server.address() as { port: number }).port;
      await expect(new Promise<number | undefined>((resolve, reject) => {
        request({ hostname: "127.0.0.1", port, ca: first.trusted }, response => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        }).on("error", reject).end();
      })).resolves.toBe(200);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
