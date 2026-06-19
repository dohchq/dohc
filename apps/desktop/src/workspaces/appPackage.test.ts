import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getAppPackage, grantAppTrust, runAppTesterStatic } from "./appPackage";

let root: string;

const VALID_APP =
  "import { dohc } from '@dohc/app'\nexport default function App(){ return <main>Ledger</main> }";

async function seedApp(appJson: string, appTsx: string): Promise<string> {
  const appRoot = join(root, "finance", ".apps", "ledger");
  await mkdir(join(appRoot, "src"), { recursive: true });
  await writeFile(join(appRoot, "app.json"), appJson);
  await writeFile(join(appRoot, "src", "App.tsx"), appTsx);
  return "finance/.apps/ledger";
}

async function editAppSource(body: string): Promise<void> {
  await writeFile(join(root, "finance", ".apps", "ledger", "src", "App.tsx"), body);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-apps-"));
});

describe("getAppPackage", () => {
  it("surfaces a local .apps folder as an app package with manifest + source", async () => {
    await seedApp(
      JSON.stringify({ title: "Ledger", write: ["transactions/**"] }),
      "export default function App(){ return null }",
    );
    const info = await getAppPackage(root, "finance/.apps/ledger/app.json");
    expect(info).toBeTruthy();
    expect(info?.name).toBe("ledger");
    expect(info?.manifest.title).toBe("Ledger");
    expect(info?.requiresTrust).toBe(true);
    expect(info?.trusted).toBe(false);
    expect(info?.readiness).toBe("needs-testing");
    expect(info?.sourceFiles).toContain("finance/.apps/ledger/src/App.tsx");
  });

  it("returns null for a path that is not in an app package", async () => {
    await writeFile(join(root, "notes.md"), "");
    expect(await getAppPackage(root, "notes.md")).toBeNull();
  });
});

describe("runAppTesterStatic (real AppTester, static mode)", () => {
  it("passes a valid @dohc/app app and marks it ready", async () => {
    const appRoot = await seedApp(
      JSON.stringify({ title: "Ledger", write: ["transactions/**"] }),
      [
        "import { dohc } from '@dohc/app'",
        "export default function App(){",
        "  return (",
        "    <main>",
        "      <h1>Ledger</h1>",
        "      <button onClick={() => dohc.collection('transactions').insert({ id: 'x' })}>",
        "        Add transaction",
        "      </button>",
        "    </main>",
        "  )",
        "}",
      ].join("\n"),
    );
    const result = await runAppTesterStatic(root, appRoot);
    expect(result.ok).toBe(true);
    // Static mode is compile-only: it runs exactly one check and intentionally
    // does NOT validate render/persistence (that is the Phase 7b runtime gate).
    expect(result.checks.map((c) => c.name)).toEqual(["compile"]);
    const info = await getAppPackage(root, appRoot);
    expect(info?.readiness).toBe("ready");
    // State is persisted as inspectable JSON under .dohc.
    const state = JSON.parse(await readFile(join(root, ".dohc", "apps-state.json"), "utf8"));
    expect(state[appRoot].passed).toBe(true);
  });

  it("fails a legacy @dohc/view app (AppTester catches it)", async () => {
    const appRoot = await seedApp(
      JSON.stringify({ title: "Old" }),
      "import { dohc } from '@dohc/view'\nexport default function App(){ return null }",
    );
    const result = await runAppTesterStatic(root, appRoot);
    expect(result.ok).toBe(false);
    expect(await getAppPackage(root, appRoot).then((i) => i?.readiness)).toBe("failed");
  });
});

describe("grantAppTrust (readiness-gated at the backend)", () => {
  it("refuses to trust an app that has not passed AppTester", async () => {
    const appRoot = await seedApp(JSON.stringify({ title: "Ledger", write: ["**"] }), VALID_APP);
    // No runAppTesterStatic call — the app is still needs-testing.
    await expect(grantAppTrust(root, appRoot)).rejects.toThrow(/AppTester/);
    expect(await getAppPackage(root, appRoot).then((i) => i?.trusted)).toBe(false);
  });

  it("refuses to trust a failed app", async () => {
    const appRoot = await seedApp(
      JSON.stringify({ title: "Old", write: ["**"] }),
      "import { dohc } from '@dohc/view'\nexport default function App(){ return null }",
    );
    await runAppTesterStatic(root, appRoot); // fails (legacy SDK)
    await expect(grantAppTrust(root, appRoot)).rejects.toThrow(/AppTester/);
    expect(await getAppPackage(root, appRoot).then((i) => i?.trusted)).toBe(false);
  });

  it("records trust once the app has passed AppTester", async () => {
    const appRoot = await seedApp(JSON.stringify({ title: "Ledger", write: ["**"] }), VALID_APP);
    await runAppTesterStatic(root, appRoot);
    await grantAppTrust(root, appRoot);
    expect(await getAppPackage(root, appRoot).then((i) => i?.trusted)).toBe(true);
  });
});

describe("content fingerprint invalidation", () => {
  it("resets readiness and trust when app source changes after a pass", async () => {
    const appRoot = await seedApp(JSON.stringify({ title: "Ledger", write: ["**"] }), VALID_APP);
    await runAppTesterStatic(root, appRoot);
    await grantAppTrust(root, appRoot);
    expect(await getAppPackage(root, appRoot).then((i) => i?.trusted)).toBe(true);

    // Editing the source after the pass must NOT inherit the old approval —
    // the changed bytes were never tested.
    await editAppSource(`${VALID_APP}\n// edited after trust`);
    const after = await getAppPackage(root, appRoot);
    expect(after?.readiness).toBe("needs-testing");
    expect(after?.trusted).toBe(false);
    // The persisted state is self-healed so no reader sees stale trust.
    const state = JSON.parse(await readFile(join(root, ".dohc", "apps-state.json"), "utf8"));
    expect(state[appRoot].trusted).toBe(false);
    expect(state[appRoot].passed).toBe(false);
  });

  it("resets trust when the manifest widens write scope after a pass", async () => {
    const appRoot = await seedApp(JSON.stringify({ title: "Ledger", write: ["transactions/**"] }), VALID_APP);
    await runAppTesterStatic(root, appRoot);
    await grantAppTrust(root, appRoot);
    // Widen the write glob — a trust decision made for a narrow scope must not
    // carry over to a broader one.
    await writeFile(
      join(root, "finance", ".apps", "ledger", "app.json"),
      JSON.stringify({ title: "Ledger", write: ["**"] }),
    );
    expect(await getAppPackage(root, appRoot).then((i) => i?.trusted)).toBe(false);
  });
});
