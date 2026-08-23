import { describe, expect, it, vi } from "vitest";
import type { SitePackageInfo, SitePreviewMode } from "./bridgeContract";
import { CHANNELS } from "./channels";
import {
  createSitesIpcHandlers,
  type SitesIpcDependencies,
} from "./sitesIpc";

interface TestEvent {
  trusted: boolean;
  senderId: number;
}

interface TestSender {
  senderId: number;
}

interface TestWorkspace {
  workspaceId: string;
  ownerMarker: "canonical";
}

function harness() {
  const trace: string[] = [];
  const subjects: string[] = [];
  const workspace: TestWorkspace = {
    workspaceId: "workspace-1",
    ownerMarker: "canonical",
  };
  let activeWorkspaceId: string | undefined = workspace.workspaceId;
  const list = vi.fn(async (authorized: TestWorkspace) => {
    trace.push(`list:${authorized.ownerMarker}`);
    return [] as SitePackageInfo[];
  });
  const get = vi.fn(
    async (
      authorized: TestWorkspace,
      path: string,
      _effectiveMode: SitePreviewMode | null | undefined,
    ): Promise<SitePackageInfo | null> => {
      trace.push(`get:${authorized.ownerMarker}:${path}`);
      return null;
    },
  );
  const dependencies: SitesIpcDependencies<
    TestEvent,
    TestSender,
    TestWorkspace
  > = {
    authority: {
      requireTrustedSender(event) {
        trace.push("trust");
        if (!event.trusted) throw new Error("Untrusted renderer.");
        return { senderId: event.senderId };
      },
      requireActiveWorkspace(sender, workspaceId, subject) {
        trace.push(`authorize:${sender.senderId}:${workspaceId}`);
        subjects.push(subject);
        if (workspaceId !== workspace.workspaceId) {
          throw new Error(`Unknown workspace: ${workspaceId}`);
        }
        if (activeWorkspaceId !== workspaceId) {
          throw new Error(
            "The sites request does not target the active workspace.",
          );
        }
        return workspace;
      },
    },
    catalog: { list, get },
  };
  return {
    trace,
    subjects,
    workspace,
    list,
    get,
    handlers: createSitesIpcHandlers(dependencies),
    setActiveWorkspaceId(value: string | undefined) {
      activeWorkspaceId = value;
    },
  };
}

const trustedEvent: TestEvent = { trusted: true, senderId: 7 };

describe("sites IPC handler record", () => {
  it("owns exactly the two site-read channels", () => {
    const { handlers } = harness();
    expect(Object.keys(handlers)).toEqual([
      CHANNELS.listSites,
      CHANNELS.getSitePackage,
    ]);
  });

  it("rejects an untrusted sender before parsing or reading", async () => {
    const { handlers, trace, list } = harness();

    await expect(
      handlers[CHANNELS.listSites]!({ trusted: false, senderId: 7 }, null),
    ).rejects.toThrow("Untrusted renderer.");

    expect(trace).toEqual(["trust"]);
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects malformed input before workspace authorization or reads", async () => {
    const { handlers, trace, list } = harness();

    await expect(
      handlers[CHANNELS.listSites]!(trustedEvent, { workspaceId: "" }),
    ).rejects.toThrow();

    expect(trace).toEqual(["trust"]);
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects unknown and inactive workspaces before owner catalog reads", async () => {
    const unknown = harness();
    await expect(
      unknown.handlers[CHANNELS.listSites]!(trustedEvent, {
        workspaceId: "workspace-missing",
      }),
    ).rejects.toThrow("Unknown workspace: workspace-missing");
    expect(unknown.list).not.toHaveBeenCalled();

    const inactive = harness();
    inactive.setActiveWorkspaceId("workspace-2");
    await expect(
      inactive.handlers[CHANNELS.getSitePackage]!(trustedEvent, {
        workspaceId: "workspace-1",
        path: "site",
      }),
    ).rejects.toThrow(/active workspace/i);
    expect(inactive.get).not.toHaveBeenCalled();
  });

  it("passes the authorized workspace to the owner catalog", async () => {
    const test = harness();

    await expect(
      test.handlers[CHANNELS.listSites]!(trustedEvent, {
        workspaceId: "workspace-1",
      }),
    ).resolves.toEqual({ sites: [] });

    expect(test.list).toHaveBeenCalledWith(test.workspace);
    expect(test.trace).toEqual([
      "trust",
      "authorize:7:workspace-1",
      "list:canonical",
    ]);
    expect(test.subjects).toEqual(["sites request"]);
  });

  it("passes the authorized workspace and requested site to the owner catalog", async () => {
    const test = harness();

    await expect(
      test.handlers[CHANNELS.getSitePackage]!(trustedEvent, {
        workspaceId: "workspace-1",
        path: "clients/acme/site",
        effectivePreviewMode: "build",
      }),
    ).resolves.toBeNull();

    expect(test.get).toHaveBeenCalledWith(
      test.workspace,
      "clients/acme/site",
      "build",
    );
    expect(test.trace).toEqual([
      "trust",
      "authorize:7:workspace-1",
      "get:canonical:clients/acme/site",
    ]);
  });

  it("does not replace an owner catalog failure with an empty result", async () => {
    const listTest = harness();
    listTest.list.mockRejectedValueOnce(
      new Error("Canonical owner unavailable."),
    );
    await expect(
      listTest.handlers[CHANNELS.listSites]!(trustedEvent, {
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow("Canonical owner unavailable.");

    const getTest = harness();
    getTest.get.mockRejectedValueOnce(
      new Error("Canonical owner unavailable."),
    );
    await expect(
      getTest.handlers[CHANNELS.getSitePackage]!(trustedEvent, {
        workspaceId: "workspace-1",
        path: "site",
      }),
    ).rejects.toThrow("Canonical owner unavailable.");
  });

  it("forwards every effective preview mode exactly", async () => {
    for (const mode of [
      "static",
      "dev",
      "build",
      null,
      undefined,
    ] as const) {
      const test = harness();
      await test.handlers[CHANNELS.getSitePackage]!(trustedEvent, {
        workspaceId: "workspace-1",
        path: "site",
        ...(mode === undefined ? {} : { effectivePreviewMode: mode }),
      });
      expect(test.get).toHaveBeenCalledWith(test.workspace, "site", mode);
    }
  });

  it("validates both results at the IPC boundary", async () => {
    const listTest = harness();
    listTest.list.mockResolvedValueOnce([{} as SitePackageInfo]);
    await expect(
      listTest.handlers[CHANNELS.listSites]!(trustedEvent, {
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow();

    const getTest = harness();
    getTest.get.mockResolvedValueOnce({} as SitePackageInfo);
    await expect(
      getTest.handlers[CHANNELS.getSitePackage]!(trustedEvent, {
        workspaceId: "workspace-1",
        path: "site",
      }),
    ).rejects.toThrow();
  });
});
