import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { memberAppSlugOf, memberAppUpload, writeForkedApp } from "./memberAppsActions";

const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const file = (path: string, text: string) => {
  const body = bytes(text);
  return { path, bytes: body, sha256: sha256(body), byteLength: body.byteLength };
};

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const personalFolder = async () => {
  const folder = await mkdtemp(join(tmpdir(), "dohc-member-apps-"));
  folders.push(folder);
  return folder;
};

describe("memberAppUpload", () => {
  it("sends the header, then each distinct file once in digest order", () => {
    const main = file("trip/main.tsx", "export {}");
    const copy = file("trip/copy.tsx", "export {}");
    const bundle = file("index.js", "console.log(1)");
    const identity = ({ bytes: _, ...entry }: ReturnType<typeof file>) => entry;
    const candidate = {
      files: [{ ...identity(bundle), contentType: "text/javascript" }],
      inputs: [identity(main), identity(copy)],
    } as unknown as AppPublicationCandidate;
    const body = memberAppUpload(
      "trip",
      candidate,
      new Map([
        [main.sha256, main.bytes],
        [bundle.sha256, bundle.bytes],
      ]),
    );
    const headerBytes = new DataView(body.buffer).getUint32(0);
    expect(JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + headerBytes)))).toEqual({
      slug: "trip",
      candidate,
    });
    const expected = [main, bundle].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
    expect(Buffer.from(body.subarray(4 + headerBytes)).toString()).toBe(
      expected.map((entry) => Buffer.from(entry.bytes).toString()).join(""),
    );
  });

  it("refuses a file that changed after dohc captured it", () => {
    const main = file("trip/main.tsx", "export {}");
    const candidate = { files: [], inputs: [main] } as unknown as AppPublicationCandidate;
    expect(() =>
      memberAppUpload("trip", candidate, new Map([[main.sha256, bytes("changed")]])),
    ).toThrow("changed while dohc read it");
  });
});

describe("writeForkedApp", () => {
  it("writes the source under the new folder", async () => {
    const folder = await personalFolder();
    await writeForkedApp(folder, "my-trip", [
      file("trip/main.tsx", "export {}"),
      file("trip/src/list.tsx", "list"),
    ]);
    expect(await readFile(join(folder, "my-trip", "main.tsx"), "utf8")).toBe("export {}");
    expect(await readFile(join(folder, "my-trip", "src", "list.tsx"), "utf8")).toBe("list");
  });

  it("leaves a folder that exists untouched", async () => {
    const folder = await personalFolder();
    await mkdir(join(folder, "mine"));
    await writeFile(join(folder, "mine", "main.tsx"), "kept");
    await expect(
      writeForkedApp(folder, "mine", [file("trip/main.tsx", "export {}")]),
    ).rejects.toThrow("already has mine");
    expect(await readFile(join(folder, "mine", "main.tsx"), "utf8")).toBe("kept");
  });

  it("refuses a file that doesn't match its digest, and writes nothing", async () => {
    const folder = await personalFolder();
    const tampered = { ...file("trip/main.tsx", "export {}"), bytes: bytes("tampered") };
    await expect(writeForkedApp(folder, "copy", [tampered])).rejects.toThrow("doesn't match");
    expect(await readdir(folder)).toEqual([]);
  });

  it("refuses a path that leaves the app's folder", async () => {
    const folder = await personalFolder();
    await expect(writeForkedApp(folder, "copy", [file("trip/../x.ts", "x")])).rejects.toThrow(
      "not a file dohc can copy",
    );
    await expect(writeForkedApp(folder, "../copy", [file("trip/x.ts", "x")])).rejects.toThrow(
      "not a folder name",
    );
    expect(await readdir(folder)).toEqual([]);
  });
});

describe("memberAppSlugOf", () => {
  it("names the app after its folder", () => {
    expect(memberAppSlugOf("Trip Board")).toBe("trip-board");
    expect(() => memberAppSlugOf("!!!")).toThrow("lowercase letters");
  });
});
