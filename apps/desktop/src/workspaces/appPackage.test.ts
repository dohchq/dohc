import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getAppPackage, grantAppTrust, runAppTesterStatic } from "./appPackage";

let root: string;

async function seedApp(appJson: string, appTsx: string): Promise<string> {
  const appRoot = join(root, "finance", ".apps", "ledger");
  await mkdir(join(appRoot, "src"), { recursive: true });
  await writeFile(join(appRoot, "app.json"), appJson);
  await writeFile(join(appRoot, "src", "App.tsx"), appTsx);
  return "finance/.apps/ledger";
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

describe("grantAppTrust", () => {
  it("records trust so the app may perform broad writes", async () => {
    const appRoot = await seedApp(JSON.stringify({ title: "Ledger", write: ["**"] }), "");
    await grantAppTrust(root, appRoot);
    expect(await getAppPackage(root, appRoot).then((i) => i?.trusted)).toBe(true);
  });
});
