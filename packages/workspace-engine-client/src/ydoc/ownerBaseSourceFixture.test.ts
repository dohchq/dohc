import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import { YdocLoopbackEngine } from "../testing/ydocLoopbackEngine";
import { YdocLiveAdapter } from "./ydocLiveAdapter";
import { YDOC_METHOD } from "./ydocWireContract";

const fixture = new URL(
  "../../../../crates/dohc-engine-collab/tests/fixtures/owner-source-seed.json",
  import.meta.url,
);

it("the daemon source fixture comes from the real captured Markdown seeder", async () => {
  const markdown = "# Shared\n\nStarting together.\n";
  const canonical = "# Shared\n\nStarting together.";
  const engine = new YdocLoopbackEngine();
  engine.seedFile({ workspace: "workspace", versionId: "main", path: "owner.md", content: markdown, contentKind: "richdoc" });
  const adapter = new YdocLiveAdapter(engine);
  const session = await adapter.openSession({ workspace: "workspace", versionId: "main", path: "owner.md", contentKind: "richdoc" });
  try {
    const records = engine.requests.filter((request) => request.method === YDOC_METHOD.recordUpdate);
    expect(records).toHaveLength(1);
    const seed = records[0]!.params as { seed: boolean; updateBase64: string };
    expect(seed.seed).toBe(true);
    const bytes = Array.from(Buffer.from(seed.updateBase64, "base64"));
    if (process.env.UPDATE_OWNER_SOURCE_FIXTURE === "1") {
      writeFileSync(fixture, `${JSON.stringify({ markdown, canonical, bytes })}\n`);
    }
    const retained = JSON.parse(readFileSync(fixture, "utf8")) as { markdown: string; canonical: string; bytes: number[] };
    expect(retained.markdown).toBe(markdown);
    expect(retained.canonical).toBe(canonical);
    for (const update of [bytes, retained.bytes]) {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, Uint8Array.from(update));
        expect(yDocToMarkdown(doc)).toBe(canonical);
        expect(doc.getMap("meta").get("dohcMarkdownSource")).toBe(markdown);
        expect(doc.getMap("meta").get("dohcMarkdownSourceSha256")).toBe(createHash("sha256").update(markdown).digest("hex"));
        expect(doc.getMap("meta").get("dohcMarkdownSourceProjectionSha256")).toBe(createHash("sha256").update(canonical).digest("hex"));
      } finally {
        doc.destroy();
      }
    }
  } finally {
    await session.close();
    adapter.dispose();
  }
});
