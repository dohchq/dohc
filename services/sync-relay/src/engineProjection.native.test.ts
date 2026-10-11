import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
import { startEngineProjection } from "./engineProjection";
import * as Y from "yjs";
const engine = requireEngineBinaryOrSkip();
const projection = engine.path
  ? await startEngineProjection({
      engineExecutable: engine.path,
      allowUnisolatedProjection: true,
    })
  : undefined;
afterAll(() => projection?.close());
describe.skipIf(engine.missing)("native store-free projection wire", () => {
  it("keeps all retained Yjs and yrs vector bytes", async () => {
    for (const file of ["yjs.json", "yrs.json"]) {
      const vectors = JSON.parse(
        readFileSync(
          new URL(
            `../../../crates/dohc-engine-sync/tests/settle-parity/${file}`,
            import.meta.url,
          ),
          "utf8",
        ),
      ) as { name: string; updates: string[]; markdown: string }[];
      for (const v of vectors) {
        const result = await projection!.project({
          contentKind: "richdoc",
          updates: v.updates.map(
            (u) => new Uint8Array(Buffer.from(u, "base64")),
          ),
        });
        expect(result, `${v.name}: ${JSON.stringify(result)}`).toMatchObject({
          kind: "projected",
        });
        if (result.kind === "projected")
          expect(result.content.toString("utf8"), v.name).toBe(v.markdown);
      }
    }
  }, 300_000);
  it("matches every shared bootstrap vector", async () => {
    const vectors = JSON.parse(
      readFileSync(
        new URL(
          "../../../crates/dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      name: string;
      bytes: number[];
      markdown: string;
      projectionRefused?: boolean;
    }[];
    for (const v of vectors) {
      const result = await projection!.project({
        contentKind: "richdoc",
        updates: [new Uint8Array(v.bytes)],
      });
      expect(result, `${v.name}: ${JSON.stringify(result)}`).toMatchObject(
        v.projectionRefused
          ? { kind: "refused", reason: "invalid" }
          : { kind: "projected" },
      );
      if (result.kind === "projected")
        expect(result.content.toString("utf8"), v.name).toBe(v.markdown);
    }
  }, 300_000);
  it("returns the named per-document error for content between 2 MiB and 16 MiB", async () => {
    const doc = new Y.Doc();
    doc.getText("plainText").insert(0, "x".repeat(2 * 1024 * 1024 + 1));
    try {
      expect(
        await projection!.project({
          contentKind: "plaintext",
          updates: [Y.encodeStateAsUpdate(doc)],
        }),
      ).toMatchObject({
        kind: "refused",
        reason: "too-large",
        message: expect.stringContaining("MAX_PUBLIC_MARKDOWN_BYTES"),
      });
    } finally {
      doc.destroy();
    }
  });
  it("refuses config before reading a file and exits", async () => {
    const child = spawn(engine.require(), ["--projection-only"], {
      env: { DOHC_ENGINE_LIVE_HOST_CONFIG: "must-not-be-read.json" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.stdout.resume();
    const code = await new Promise<number | null>((resolve) =>
      child.once("close", resolve),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("projection mode takes no configuration");
  });
});
