import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantAppTrust, runAppTesterStatic } from "./appPackage";
import { getAppRuntime, runAppRuntimeRpc } from "./appRuntime";
import { isAppRuntimeFrameUrl } from "./appRuntimeRegistry";

let root: string;

async function seedApp(manifest: Record<string, unknown>): Promise<string> {
  const appRoot = join(root, "finance", ".apps", "ledger");
  await mkdir(join(appRoot, "src"), { recursive: true });
  await writeFile(join(appRoot, "app.json"), JSON.stringify(manifest));
  await writeFile(
    join(appRoot, "src", "App.tsx"),
    [
      "import { dohc } from '@dohc/app'",
      "export default function App(){",
      "  return <main>Ledger</main>",
      "}",
    ].join("\n"),
  );
  return "finance/.apps/ledger";
}

async function trustReadyApp(manifest: Record<string, unknown>): Promise<string> {
  const appRoot = await seedApp(manifest);
  await runAppTesterStatic(root, appRoot);
  await grantAppTrust(root, appRoot);
  return appRoot;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-app-runtime-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("app runtime shell", () => {
  it("only returns a runtime document for a passed and trusted app", async () => {
    const appRoot = await seedApp({
      title: "Ledger",
      read: ["transactions/**"],
      write: ["transactions/**"],
    });

    await expect(getAppRuntime(root, appRoot)).rejects.toThrow(/AppTester/);
    await runAppTesterStatic(root, appRoot);
    await grantAppTrust(root, appRoot);

    const runtime = await getAppRuntime(root, appRoot);
    expect(runtime.title).toBe("Ledger");
    expect(runtime.root).toBe(appRoot);
    expect(runtime.src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(isAppRuntimeFrameUrl(runtime.src)).toBe(true);
    expect(isAppRuntimeFrameUrl("http://127.0.0.1:9/not-runtime/index.html")).toBe(false);
    const response = await fetch(runtime.src);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain('src="./runtime.js"');
    const scriptResponse = await fetch(runtime.src.replace("index.html", "runtime.js"));
    expect(scriptResponse.status).toBe(200);
    expect(await scriptResponse.text()).toContain("dohc:runtime-ready");
  });
});

describe("runAppRuntimeRpc", () => {
  it("persists inserted collection records as visible workspace JSON files", async () => {
    const appRoot = await trustReadyApp({
      title: "Ledger",
      read: ["transactions/**"],
      write: ["transactions/**"],
    });

    const inserted = await runAppRuntimeRpc(root, appRoot, {
      id: "1",
      op: "collection.insert",
      args: { name: "transactions", record: { id: "x", amount: 42 } },
    });

    expect(inserted).toEqual({ row: { id: "x", amount: 42 } });
    const onDisk = JSON.parse(
      await readFile(join(root, "finance", "transactions", "x.json"), "utf8"),
    );
    expect(onDisk).toEqual({ id: "x", amount: 42 });

    const listed = await runAppRuntimeRpc(root, appRoot, {
      id: "2",
      op: "collection.list",
      args: { name: "transactions" },
    });
    expect(listed).toEqual({ rows: [{ id: "x", amount: 42 }] });
  });

  it("refuses untrusted or out-of-scope collection writes", async () => {
    const untrusted = await seedApp({
      title: "Ledger",
      read: ["transactions/**"],
      write: ["transactions/**"],
    });
    await runAppTesterStatic(root, untrusted);

    await expect(
      runAppRuntimeRpc(root, untrusted, {
        id: "1",
        op: "collection.insert",
        args: { name: "transactions", record: { id: "x" } },
      }),
    ).rejects.toThrow(/trusted/);

    const scopedElsewhere = await trustReadyApp({
      title: "Ledger",
      read: ["transactions/**"],
      write: ["other/**"],
    });
    await expect(
      runAppRuntimeRpc(root, scopedElsewhere, {
        id: "2",
        op: "collection.insert",
        args: { name: "transactions", record: { id: "x" } },
      }),
    ).rejects.toThrow(/outside/);
  });

  it("refuses to overwrite an existing collection record", async () => {
    const appRoot = await trustReadyApp({
      title: "Ledger",
      read: ["transactions/**"],
      write: ["transactions/**"],
    });

    await runAppRuntimeRpc(root, appRoot, {
      id: "1",
      op: "collection.insert",
      args: { name: "transactions", record: { id: "x", amount: 42 } },
    });
    await expect(
      runAppRuntimeRpc(root, appRoot, {
        id: "2",
        op: "collection.insert",
        args: { name: "transactions", record: { id: "x", amount: 99 } },
      }),
    ).rejects.toThrow(/already exists/);

    const onDisk = JSON.parse(
      await readFile(join(root, "finance", "transactions", "x.json"), "utf8"),
    );
    expect(onDisk).toEqual({ id: "x", amount: 42 });
  });

  it("uses collision-free record filenames for encoded ids", async () => {
    const appRoot = await trustReadyApp({
      title: "Ledger",
      read: ["transactions/**"],
      write: ["transactions/**"],
    });

    await runAppRuntimeRpc(root, appRoot, {
      id: "1",
      op: "collection.insert",
      args: { name: "transactions", record: { id: "/" } },
    });
    await runAppRuntimeRpc(root, appRoot, {
      id: "2",
      op: "collection.insert",
      args: { name: "transactions", record: { id: "~2F" } },
    });

    expect(
      JSON.parse(await readFile(join(root, "finance", "transactions", "~2F.json"), "utf8")),
    ).toEqual({ id: "/" });
    expect(
      JSON.parse(await readFile(join(root, "finance", "transactions", "~7E2F.json"), "utf8")),
    ).toEqual({ id: "~2F" });
  });

  it("refuses collection writes through symlinked scope paths", async () => {
    const appRoot = await trustReadyApp({
      title: "Ledger",
      read: ["transactions/**"],
      write: ["transactions/**"],
    });
    await mkdir(join(root, "finance", "private"), { recursive: true });
    await symlink(
      join(root, "finance", "private"),
      join(root, "finance", "transactions"),
      "dir",
    );

    await expect(
      runAppRuntimeRpc(root, appRoot, {
        id: "1",
        op: "collection.insert",
        args: { name: "transactions", record: { id: "x" } },
      }),
    ).rejects.toThrow(/symbolic links/);
  });
});
