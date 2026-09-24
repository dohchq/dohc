import { describe, expect, it, vi } from "vitest";
import type { SitePackageInfo } from "../workspaces/sitePackage";
import { createSitePreviewLifecycle } from "../workspaces/sitePreviewLifecycle";
import type { SitePreviewResultBody } from "./sitePreviewIpc";
import type { StaticSitePreview } from "../workspaces/siteRunner";
import {
  createStartSitePreviewHandler,
  type StartSitePreviewDependencies,
} from "./sitePreviewIpc";

interface TestSender {
  id: number;
  destroyed: boolean;
  isDestroyed(): boolean;
}

interface TestEvent {
  trusted: boolean;
  sender: TestSender;
}

interface TestWorkspace {
  workspaceId: string;
  rootPath: string;
  ownerMarker: "canonical";
}

function site(root = "site"): SitePackageInfo {
  return {
    root,
    title: "Site",
    kind: "static",
    confidence: "high",
    entryPath: `${root}/index.html`,
    configPath: null,
    packagePath: null,
    packageManager: null,
    scripts: {},
    configuredScripts: {},
    configuredPreviewMode: "static",
    configuredBuildOutput: null,
    buildOutputs: [],
    sourceFiles: [`${root}/index.html`],
    shareManifest: { ok: false, reason: "no-runnable-artifact" },
    diagnostics: [],
    authority: { kind: "workspace" },
  };
}

function harness(input: {
  catalogSite?: SitePackageInfo | null;
  sharedView?: boolean;
  activeWorkspaceId?: string;
} = {}) {
  const workspace: TestWorkspace = {
    workspaceId: "workspace-1",
    rootPath: "/workspace",
    ownerMarker: "canonical",
  };
  const sender: TestSender = {
    id: 7,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  let sessionCurrent = true;
  const subjects: Array<{ subject: string; action: string }> = [];
  const get = vi.fn(async () =>
    input.catalogSite === undefined ? site() : input.catalogSite,
  );
  const handle: StaticSitePreview = {
    url: "http://127.0.0.1:4173/",
    root: "/workspace/site",
    stop: vi.fn(async () => undefined),
  };
  const execute = vi.fn(async (executionInput) => ({
    handle,
    result: {
      siteRoot: executionInput.site.root,
      mode: executionInput.mode,
      logs: [],
    },
  }));
  const lifecycle = createSitePreviewLifecycle<SitePreviewResultBody>({
    allowOrigin: () => () => undefined,
  });
  const dependencies: StartSitePreviewDependencies<
    TestEvent,
    TestSender,
    TestWorkspace
  > = {
    authority: {
      requireTrustedSender(event) {
        if (!event.trusted) throw new Error("Untrusted renderer.");
        return event.sender;
      },
      withActiveWorkspace(_sender, workspaceId, subject, action, work) {
        subjects.push({ subject, action });
        if (workspaceId !== workspace.workspaceId) {
          throw new Error(`Unknown workspace: ${workspaceId}`);
        }
        if (
          (input.activeWorkspaceId ?? workspace.workspaceId) !== workspaceId
        ) {
          throw new Error(
            `The ${subject} does not target the active workspace. Open the workspace and ${action}.`,
          );
        }
        if (!sessionCurrent) {
          throw new Error(
            `The ${subject} does not target the active workspace. Open the workspace and ${action}.`,
          );
        }
        return work({
          workspace,
          session: { isCurrent: () => sessionCurrent },
        });
      },
    },
    catalog: { list: async () => [], get },
    lifecycle,
    isSharedView: () => input.sharedView ?? false,
    execute,
  };
  return {
    event: { trusted: true, sender } satisfies TestEvent,
    workspace,
    subjects,
    get,
    execute,
    handle,
    lifecycle,
    handler: createStartSitePreviewHandler(dependencies),
    retireSession() {
      sessionCurrent = false;
    },
  };
}

describe("start site preview IPC", () => {
  it("routes an authorized exact site through the lifecycle and execution policy", async () => {
    const test = harness();

    const result = await test.handler(test.event, {
      workspaceId: "workspace-1",
      siteRoot: "site",
      mode: "static",
      holderId: "tab",
      restart: false,
    });

    expect(result).toEqual({
      siteRoot: "site",
      mode: "static",
      url: test.handle.url,
      logs: [],
      exited: false,
    });
    expect(result).not.toHaveProperty("handle");
    expect(test.subjects).toEqual([
      {
        subject: "app preview request",
        action: "start the preview again",
      },
    ]);
    expect(test.get).toHaveBeenCalledWith(test.workspace, "site", "static");
    expect(test.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        workspaceRoot: "/workspace",
        site: expect.objectContaining({ root: "site" }),
        mode: "static",
        sharedView: false,
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      }),
    );
    await test.lifecycle.stopAll();
  });

  it("rejects a detected ancestor before execution", async () => {
    const test = harness({ catalogSite: site("ancestor") });

    await expect(
      test.handler(test.event, {
        workspaceId: "workspace-1",
        siteRoot: "ancestor/stale-child",
        mode: "dev",
        holderId: "tab",
        restart: false,
      }),
    ).rejects.toThrow("Not a detected app: ancestor/stale-child");

    expect(test.get).toHaveBeenCalledWith(
      test.workspace,
      "ancestor/stale-child",
      "dev",
    );
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("rejects dynamic execution in a shared view before catalog lookup", async () => {
    const test = harness({ sharedView: true });

    await expect(
      test.handler(test.event, {
        workspaceId: "workspace-1",
        siteRoot: "site",
        mode: "build",
        holderId: "tab",
        restart: false,
      }),
    ).rejects.toThrow(
      "Live and built app previews run the app's own code, so they're disabled in a shared view. Use the static preview.",
    );

    expect(test.get).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("rejects dynamic execution from shared-with-me before catalog lookup", async () => {
    const test = harness();

    await expect(
      test.handler(test.event, {
        workspaceId: "workspace-1",
        siteRoot: "shared-with-me/team/site",
        mode: "dev",
        holderId: "tab",
        restart: false,
      }),
    ).rejects.toThrow(
      "Apps opened from shared-with-me use the static preview. Copy it into your own files to run dev or build commands.",
    );

    expect(test.get).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("allows a shared static preview and tells execution that it is shared", async () => {
    const root = "shared-with-me/team/site";
    const test = harness({ catalogSite: site(root), sharedView: true });

    await expect(
      test.handler(test.event, {
        workspaceId: "workspace-1",
        siteRoot: root,
        mode: "static",
        holderId: "tab",
        restart: false,
      }),
    ).resolves.toMatchObject({ siteRoot: root, mode: "static" });

    expect(test.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sharedView: true }),
    );
    await test.lifecycle.stopAll();
  });

  it("rejects an inactive workspace before catalog lookup", async () => {
    const test = harness({ activeWorkspaceId: "workspace-2" });

    await expect(
      test.handler(test.event, {
        workspaceId: "workspace-1",
        siteRoot: "site",
        mode: "static",
        holderId: "tab",
        restart: false,
      }),
    ).rejects.toThrow(
      "The app preview request does not target the active workspace. Open the workspace and start the preview again.",
    );

    expect(test.get).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("rejects an untrusted sender before parsing", async () => {
    const test = harness();

    await expect(
      test.handler({ ...test.event, trusted: false }, null),
    ).rejects.toThrow("Untrusted renderer.");

    expect(test.get).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("stops a late handle when the renderer session retires", async () => {
    const test = harness();
    let finishExecution: () => void = () => undefined;
    const executionGate = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    test.execute.mockImplementationOnce(async (executionInput) => {
      await executionGate;
      return {
        handle: test.handle,
        result: {
          siteRoot: executionInput.site.root,
          mode: executionInput.mode,
          logs: [],
        },
      };
    });
    const starting = test.handler(test.event, {
      workspaceId: "workspace-1",
      siteRoot: "site",
      mode: "static",
      holderId: "tab",
      restart: false,
    });
    await vi.waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));

    test.retireSession();
    finishExecution();

    await expect(starting).rejects.toThrow(/renderer restarted/i);
    expect(test.handle.stop).toHaveBeenCalledTimes(1);
  });

  it("denies a fresh start synchronously after reload retirement begins", async () => {
    const test = harness();
    test.retireSession();

    await expect(
      test.handler(test.event, {
        workspaceId: "workspace-1",
        siteRoot: "site",
        mode: "static",
        holderId: "tab",
        restart: false,
      }),
    ).rejects.toThrow(/active workspace/i);

    expect(test.get).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });
});
