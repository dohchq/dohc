import { after, before } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_NODE } from "./pinned-node.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
// Verification lanes keep node_modules between runs, so a kept download outlives the checkout's clean.
const defaultCache = fileURLToPath(new URL("../../../node_modules/.cache/dohc-pinned-node/", import.meta.url));

/**
 * A fetch that keeps each pinned Node download once it has its pinned hash, and serves it from then on without
 * the network. Any other request goes to `download` unchanged.
 */
export function cachedNodeFetch({ cache = defaultCache, download = globalThis.fetch, pinned = PINNED_NODE } = {}) {
  return async (url, init) => {
    const entry = Object.values(pinned).find(candidate => candidate.url && candidate.url === String(url));
    if (!entry) return download(url, init);
    // An archive has its own hash; a bare executable such as node.exe is the download itself.
    const sha256 = entry.archiveSha256 ?? entry.sha256;
    const path = join(cache, sha256);
    const kept = await readFile(path).catch(() => null);
    if (kept && hash(kept) === sha256) return new Response(kept);
    const response = await download(url, init);
    if (!response.ok || !response.body) return response;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) === sha256) {
      await mkdir(cache, { recursive: true });
      const partial = `${path}.${process.pid}.partial`;
      await writeFile(partial, bytes);
      await rename(partial, path).catch(() => rm(partial, { force: true }));
    }
    return new Response(bytes, { status: response.status });
  };
}

/** For the tests in this file, the global fetch keeps pinned Node downloads, so only a first run needs the network. */
export function useCachedNodeDownloads() {
  const original = globalThis.fetch;
  before(() => { globalThis.fetch = cachedNodeFetch({ download: original }); });
  after(() => { globalThis.fetch = original; });
}
