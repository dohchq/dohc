import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./launch";

const SHOT_DIR = "test-results/screenshots/phase-07";

// A workspace with two app packages: a valid @dohc/app app that AppTester
// should pass, and a legacy @dohc/view app it must reject. Apps live as plain
// source folders under <area>/.apps/<name> — nothing hidden, fully inspectable.
async function seededWorkspace(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "dohc-app-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-app-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId: "app-ws", kind: "personal", mode: "local-first" }),
  );

  const ledger = join(root, "finance", ".apps", "ledger", "src");
  await mkdir(ledger, { recursive: true });
  await writeFile(
    join(root, "finance", ".apps", "ledger", "app.json"),
    JSON.stringify({ title: "Ledger", write: ["transactions/**"] }),
  );
  await writeFile(
    join(ledger, "App.tsx"),
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

  const legacy = join(root, "notes", ".apps", "old", "src");
  await mkdir(legacy, { recursive: true });
  await writeFile(
    join(root, "notes", ".apps", "old", "app.json"),
    JSON.stringify({ title: "Old" }),
  );
  await writeFile(
    join(legacy, "App.tsx"),
    "import { dohc } from '@dohc/view'\nexport default function App(){ return null }",
  );

  return JSON.stringify({ home, root });
}

test("an app passes AppTester and can be trusted; a legacy app is rejected", async () => {
  const { home, root } = JSON.parse(await seededWorkspace());
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();

  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  async function open(path: string) {
    await page.getByTestId("file-tree").getByText(path, { exact: true }).click();
    await expect(page.getByTestId("view-app")).toBeVisible();
  }

  const { mkdir: mkdirP } = await import("node:fs/promises");
  await mkdirP(SHOT_DIR, { recursive: true });

  // Valid app: starts untested, passes AppTester, then becomes trustable.
  await open("finance/.apps/ledger/app.json");
  await expect(page.getByTestId("app-readiness")).toHaveAttribute(
    "data-readiness",
    "needs-testing",
  );
  await expect(page.getByTestId("trust-app")).toHaveCount(0);

  await page.getByTestId("run-app-tester").click();
  await expect(page.getByTestId("app-readiness")).toHaveAttribute("data-readiness", "ready", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("app-test-checks")).toContainText(/compile/i);
  await page.screenshot({ path: `${SHOT_DIR}/app-ready--1280x800--light.png` });

  await expect(page.getByTestId("trust-app")).toBeVisible();
  await page.getByTestId("trust-app").click();
  await expect(page.getByTestId("trust-app")).toHaveCount(0);
  // Positively confirm the app is now Trusted (not merely that the button left).
  await expect(page.getByTestId("view-app")).toContainText("Trusted");

  // Legacy @dohc/view app: AppTester catches the wrong SDK and marks it failed.
  await open("notes/.apps/old/app.json");
  await page.getByTestId("run-app-tester").click();
  await expect(page.getByTestId("app-readiness")).toHaveAttribute("data-readiness", "failed", {
    timeout: 30_000,
  });
  // A failed app must never be trustable — the trust affordance is absent.
  await expect(page.getByTestId("trust-app")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT_DIR}/app-failed--1280x800--light.png` });

  await app.close();
});
