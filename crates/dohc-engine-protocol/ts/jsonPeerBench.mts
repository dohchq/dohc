// The desktop client is a JS peer: whatever codec the wire uses, V8 must
// decode it. JSON.parse/JSON.stringify are the V8-native baseline that a JS
// CBOR/MessagePack/Protobuf library has to beat (they generally do not).
//
// Usage: node ts/jsonPeerBench.mts

interface FileMetadata {
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
}

// Deterministic LCG matching the Rust bench's payload shape.
let state = 42n;
function next(): bigint {
  state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
  return state;
}

function buildManifest(entries: number): { files: FileMetadata[] } {
  const files: FileMetadata[] = [];
  for (let index = 0; index < entries; index += 1) {
    let hash = "";
    for (let i = 0; i < 64; i += 1) hash += (next() % 16n).toString(16);
    files.push({
      path: `notes/area-${index % 37}/topic-${index % 111}/document-${index}.md`,
      size: Number(next() % 2000000n),
      sha256: hash,
      mediaType: "text/markdown",
    });
  }
  return { files };
}

function bench(label: string, iters: number, op: () => unknown, bytes: number): void {
  let best = Number.MAX_VALUE;
  for (let run = 0; run < 5; run += 1) {
    const started = process.hrtime.bigint();
    for (let i = 0; i < iters; i += 1) op();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6 / iters;
    best = Math.min(best, elapsedMs);
  }
  const mbps = bytes / 1e6 / (best / 1e3);
  console.log(`| ${label} | ${(best * 1000).toFixed(2)} | ${mbps.toFixed(0)} |`);
}

const manifest = buildManifest(10_000);
const manifestJson = JSON.stringify(manifest);
const small = {
  id: 42,
  method: "workspace.open",
  deadlineMs: 5000,
  idempotencyKey: "open-42-6d1f",
  params: { profile: "default", warm: true },
};
const smallJson = JSON.stringify(small);

console.log(`### V8 (node ${process.version}) JSON peer cost\n`);
console.log("| operation | us/op | MB/s |");
console.log("| --- | --- | --- |");
bench("JSON.stringify small envelope", 200_000, () => JSON.stringify(small), smallJson.length);
bench("JSON.parse small envelope", 200_000, () => JSON.parse(smallJson), smallJson.length);
bench("JSON.stringify 10k manifest", 30, () => JSON.stringify(manifest), manifestJson.length);
bench("JSON.parse 10k manifest", 30, () => JSON.parse(manifestJson), manifestJson.length);
