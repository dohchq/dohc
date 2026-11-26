import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import {
  createMemberAppsActions,
  memberAppSlugOf,
  memberAppUpload,
  writeForkedApp,
} from "./memberAppsActions";

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

  it("puts a nested app's manifest at the top of the copy", async () => {
    const folder = await personalFolder();
    await writeForkedApp(folder, "trip-copy", [
      file("examples/trip/app.publish.json", "{}"),
      file("examples/trip/main.ts", "x"),
      file("examples/trip/portal/app.publish.json", "[]"),
    ]);
    expect(await readFile(join(folder, "trip-copy", "app.publish.json"), "utf8")).toBe("{}");
    expect(await readFile(join(folder, "trip-copy", "main.ts"), "utf8")).toBe("x");
    expect(await readFile(join(folder, "trip-copy", "portal", "app.publish.json"), "utf8")).toBe(
      "[]",
    );
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

  it("copies source under a folder name a workspace path can't start with", async () => {
    const folder = await personalFolder();
    await writeForkedApp(folder, "copy", [file("trip/shared-with-me/main.ts", "x")]);
    expect(await readFile(join(folder, "copy", "shared-with-me", "main.ts"), "utf8")).toBe("x");
  });

  it("refuses a copy name dohc can't build", async () => {
    const folder = await personalFolder();
    await expect(writeForkedApp(folder, "my trip", [file("trip/main.ts", "x")])).rejects.toThrow(
      "lowercase letters",
    );
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
  it("names the app after its folder, and never gives two folders one name", () => {
    expect(memberAppSlugOf("trip-board")).toBe("trip-board");
    expect(() => memberAppSlugOf("trip_board")).toThrow("Rename the folder trip_board");
    expect(() => memberAppSlugOf("Trip Board")).toThrow("lowercase letters");
  });
});

describe("createMemberAppsActions", () => {
  const operation = {
    workspace: { workspaceId: "ws", rootPath: "/w" },
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
  };
  type Capture = (paths: readonly string[]) => Promise<void>;
  const actionsAnswering = (
    answer: (path: string, init: RequestInit) => Response,
    failCapture?: Capture,
  ) => {
    const sent: Array<{ path: string; body: unknown }> = [];
    const remote = async (_workspace: unknown, options?: { allowPaused: boolean }) => {
      if (!options?.allowPaused) throw new Error("Sync this workspace before sharing.");
      return { credentials: "token", credentialGeneration: 1 };
    };
    const captured: string[][] = [];
    const actions = createMemberAppsActions({
      remoteForWorkspace: remote,
      remoteForJoinedWorkspace: () => remote(null, { allowPaused: true }),
      currentCredentialGeneration: () => 1,
      relayResponse: async (_credentials, path, init) => {
        sent.push({
          path,
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        return answer(path, init);
      },
      serverAnswered: () => undefined,
      personalFolder: () => null,
      preparePersonalApp: async () => {
        throw new Error("unused");
      },
      withVersionLock: (_operation, work) => work(versionId),
      capture: async (_operation, paths) => {
        if (failCapture) return failCapture(paths);
        captured.push([...paths]);
      },
    });
    return { actions, sent, captured };
  };
  let versionId = "main";
  afterEach(() => {
    versionId = "main";
  });

  const shared = (files: ReturnType<typeof file>[], served = files, failCapture?: Capture) =>
    actionsAnswering((path) => {
      if (path.endsWith("/backend/summary"))
        return Response.json({
          subjectName: "trip",
          sharerName: "Ana",
          review: {
            authorityRevision: 3,
            consent: "none",
            collections: [],
            source: files.map(({ bytes: _, ...entry }) => entry),
          },
        });
      const digest = /\/blobs\/([0-9a-f]{64})/.exec(path)?.[1];
      const blob = served.find((entry) => entry.sha256 === digest);
      return blob
        ? new Response(blob.bytes, { headers: { "content-type": "application/octet-stream" } })
        : Response.json({ error: "missing" }, { status: 404 });
    }, failCapture);
  const publicationId = "a".repeat(64);
  const ownedAt = (rootPath: string) => ({
    ...operation,
    workspace: { workspaceId: "ws", rootPath },
  });
  const manifest = (extra: Record<string, unknown> = {}) =>
    file(
      "trip/app.publish.json",
      JSON.stringify({ entryPath: "index.html", inputs: ["index.html"], ...extra }),
    );

  describe("promote", () => {
    it("copies a Member app into a nested workspace folder and captures every file", async () => {
      const root = await personalFolder();
      const { actions, captured } = shared([manifest(), file("trip/index.html", "<p>hi</p>")]);
      await expect(
        actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
      ).resolves.toEqual({ folder: "apps/trip" });
      expect(await readFile(join(root, "apps", "trip", "index.html"), "utf8")).toBe("<p>hi</p>");
      expect(captured).toEqual([["apps/trip/app.publish.json", "apps/trip/index.html"]]);
    });

    it("refuses a workspace the person joined, before asking the server", async () => {
      const { actions, sent } = shared([file("trip/index.html", "x")]);
      const joined = { ...operation, workspace: { ...operation.workspace, shareView: null } };
      await expect(actions.promote(joined, { publicationId, folder: "apps/trip" })).rejects.toThrow(
        "Only the workspace's owner",
      );
      expect(sent).toEqual([]);
    });

    it("refuses another version than Main, and writes nothing", async () => {
      const root = await personalFolder();
      versionId = "v1";
      const { actions, captured } = shared([file("trip/index.html", "x")]);
      await expect(
        actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
      ).rejects.toThrow("Switch to Main");
      expect(await readdir(root)).toEqual([]);
      expect(captured).toEqual([]);
    });

    it("refuses a file that doesn't match the reviewed digest, and writes nothing", async () => {
      const root = await personalFolder();
      const index = file("trip/index.html", "x");
      const { actions } = shared([index], [{ ...index, bytes: bytes("tampered") }]);
      await expect(
        actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
      ).rejects.toThrow("doesn't match the app the author shared");
      expect(await readdir(root)).toEqual([]);
    });

    it("refuses an app that calls outside services, and writes nothing", async () => {
      const root = await personalFolder();
      const external = {
        usage: {
          method: "GET",
          url: "https://api.example.com/v1/usage",
          secret: { name: "EXAMPLE_KEY", header: "X-Api-Key" },
        },
      };
      const { actions } = shared([manifest({ external }), file("trip/index.html", "x")]);
      await expect(
        actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
      ).rejects.toThrow("calls outside services");
      expect(await readdir(root)).toEqual([]);
    });

    it("refuses inputs outside the new folder, and writes nothing", async () => {
      const root = await personalFolder();
      const { actions } = shared([
        manifest({ inputs: ["index.html", "../notes.md"] }),
        file("trip/index.html", "x"),
      ]);
      await expect(
        actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
      ).rejects.toThrow("outside its own folder");
      expect(await readdir(root)).toEqual([]);
    });

    it("refuses a secret or reserved folder", async () => {
      const root = await personalFolder();
      const { actions } = shared([file("trip/index.html", "x")]);
      for (const folder of [".env", "apps/.env", "../apps", ".dohc/apps"])
        await expect(actions.promote(ownedAt(root), { publicationId, folder })).rejects.toThrow(
          "not a folder dohc can promote an app into",
        );
      expect(await readdir(root)).toEqual([]);
    });

    it("leaves a folder that exists untouched", async () => {
      const root = await personalFolder();
      await mkdir(join(root, "apps", "trip"), { recursive: true });
      await writeFile(join(root, "apps", "trip", "index.html"), "kept");
      const { actions, captured } = shared([file("trip/index.html", "x")]);
      await expect(
        actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
      ).rejects.toThrow("already has apps/trip");
      expect(await readFile(join(root, "apps", "trip", "index.html"), "utf8")).toBe("kept");
      expect(captured).toEqual([]);
    });

    it("refuses a folder reached through a link, and writes nothing", async () => {
      const root = await personalFolder();
      await mkdir(join(root, "docs"));
      await symlink(join(root, "docs"), join(root, "apps"), "junction");
      const { actions, captured } = shared([file("trip/index.html", "x")]);
      await expect(
        actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
      ).rejects.toThrow("goes through a link");
      expect(await readdir(join(root, "docs"))).toEqual([]);
      expect(captured).toEqual([]);
    });

    it("refuses files whose names differ only by case, before writing", async () => {
      const root = await personalFolder();
      const { actions } = shared([file("trip/Logo.svg", "a"), file("trip/logo.svg", "b")]);
      await expect(
        actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
      ).rejects.toThrow("differ only by case");
      expect(await readdir(root)).toEqual([]);
    });

    it("refuses a file and a folder whose names differ only by case, before writing", async () => {
      const root = await personalFolder();
      const { actions } = shared([
        file("trip/assets.js", "a"),
        file("trip/Assets.js/logo.svg", "b"),
      ]);
      await expect(
        actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
      ).rejects.toThrow("differ only by case");
      expect(await readdir(root)).toEqual([]);
    });

    it("refuses a file larger than History keeps, naming its size", async () => {
      const root = await personalFolder();
      const { actions } = shared([file("trip/photo.txt", "x".repeat(6 * 1024 * 1024))]);
      await expect(
        actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
      ).rejects.toThrow("photo.txt is 6.0 MiB. dohc promotes files up to 5 MiB.");
      expect(await readdir(root)).toEqual([]);
    });

    it.runIf(process.platform === "win32")(
      "refuses a name Windows can't save, before writing",
      async () => {
        for (const name of ["nul.md", "notes?.txt"]) {
          const root = await personalFolder();
          const { actions } = shared([file("trip/index.html", "x"), file(`trip/${name}`, "y")]);
          await expect(
            actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
          ).rejects.toThrow(name);
          expect(await readdir(root)).toEqual([]);
        }
      },
    );

    it("names the copy when History can't record it", async () => {
      const root = await personalFolder();
      const { actions } = shared([file("trip/index.html", "x")], undefined, async () => {
        throw new Error("dohc could not capture these files. Reopen the workspace.");
      });
      await expect(
        actions.promote(ownedAt(root), { publicationId, folder: "apps/trip" }),
      ).rejects.toThrow("copied the app into apps/trip, but History hasn't recorded it yet.");
      expect(await readFile(join(root, "apps", "trip", "index.html"), "utf8")).toBe("x");
    });
  });

  describe("source", () => {
    it("reads a text file, and gives no text for a binary file or one over 256 KiB", async () => {
      const png = { ...file("trip/logo.png", ""), bytes: new Uint8Array([0x89, 0xff, 0xfe]) };
      png.sha256 = sha256(png.bytes);
      png.byteLength = 3;
      const big = file("trip/big.js", "x".repeat(256 * 1024 + 1));
      const { actions, sent } = shared([file("trip/index.html", "<p>hi</p>"), png, big]);
      const read = (path: string) => actions.source(operation, { publicationId, path });
      await expect(read("trip/index.html")).resolves.toEqual({
        path: "trip/index.html",
        byteLength: 9,
        text: "<p>hi</p>",
      });
      await expect(read("trip/logo.png")).resolves.toMatchObject({ text: null });
      await expect(read("trip/big.js")).resolves.toMatchObject({ text: null });
      expect(sent.filter(({ path }) => path.includes(big.sha256))).toEqual([]);
    });
  });

  it("sends the relay only the sharing switch, whatever else the caller passed, even while sync is paused", async () => {
    const { actions, sent } = actionsAnswering(() => Response.json({ membersCanShare: true }));
    const input = { membersCanShare: true, cwd: "/w", actor: "agent" };
    await expect(actions.sharing(operation, input)).resolves.toEqual({ membersCanShare: true });
    expect(sent.map(({ body }) => body)).toEqual([{ membersCanShare: true }]);
  });

  it("lists no apps on a server that doesn't serve Member apps", async () => {
    const { actions } = actionsAnswering(() =>
      Response.json({ ok: false, error: "not found", code: "not_found" }, { status: 404 }),
    );
    await expect(actions.list(operation, {})).resolves.toEqual({ apps: [], nextCursor: null });
  });

  it("waits out the server's rate limit on a read", async () => {
    let limited = 2;
    const { actions, sent } = actionsAnswering(() =>
      limited-- > 0
        ? Response.json({ code: "rate_limited" }, { status: 429, headers: { "retry-after": "0" } })
        : Response.json({
            subjectName: "trip",
            sharerName: "Ana",
            review: { authorityRevision: 3, consent: "none", collections: [], source: [] },
          }),
    );
    await expect(actions.inspect(operation, { publicationId: "p1" })).resolves.toMatchObject({
      name: "trip",
    });
    expect(sent).toHaveLength(3);
  });
});
