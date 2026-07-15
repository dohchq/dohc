export interface SitePreviewSdkGrantInput {
  senderId: number;
  generation: number;
  workspaceId: string;
  siteRoot: string;
  workspaceRoot: string;
  scopeRoot: string | null;
  writable: boolean;
}

export interface SitePreviewSdkGrant extends SitePreviewSdkGrantInput {
  signal: AbortSignal;
}

interface StoredGrant extends SitePreviewSdkGrantInput {
  controller: AbortController;
}

function grantKey(senderId: number, workspaceId: string, siteRoot: string): string {
  return `${senderId}\0${workspaceId}\0${siteRoot}`;
}

/**
 * Server-side authority for the SDK bridge. A payload naming a workspace and
 * site is never authority by itself: only the renderer that started the live
 * preview receives a grant, and that grant expires with its renderer
 * generation or the preview handle.
 */
export function createSitePreviewSdkAuthorityRegistry() {
  const grants = new Map<string, StoredGrant>();

  const revoke = (key: string, grant: StoredGrant) => {
    grants.delete(key);
    grant.controller.abort();
  };

  return {
    register(input: SitePreviewSdkGrantInput): SitePreviewSdkGrant {
      // There is one main-owned preview handle per workspace/site. If another
      // renderer replaces it, the old renderer must lose access immediately.
      for (const [key, grant] of grants) {
        if (grant.workspaceId === input.workspaceId && grant.siteRoot === input.siteRoot) {
          revoke(key, grant);
        }
      }
      const controller = new AbortController();
      grants.set(grantKey(input.senderId, input.workspaceId, input.siteRoot), {
        ...input,
        controller,
      });
      return { ...input, signal: controller.signal };
    },

    authorize(input: {
      senderId: number;
      generation: number;
      activeWorkspaceId: string | undefined;
      workspaceId: string;
      siteRoot: string;
      previewRunning: boolean;
    }): SitePreviewSdkGrant {
      if (input.activeWorkspaceId !== input.workspaceId) {
        throw new Error("Site SDK request does not target this renderer's active workspace.");
      }
      const key = grantKey(input.senderId, input.workspaceId, input.siteRoot);
      const grant = grants.get(key);
      if (!grant) {
        throw new Error("Site SDK request does not belong to an active preview in this renderer.");
      }
      if (grant.generation !== input.generation || !input.previewRunning) {
        revoke(key, grant);
        throw new Error("Site SDK preview authority is stale.");
      }
      return { ...grant, signal: grant.controller.signal };
    },

    revokePreview(workspaceId: string, siteRoot: string): void {
      for (const [key, grant] of grants) {
        if (grant.workspaceId === workspaceId && grant.siteRoot === siteRoot) revoke(key, grant);
      }
    },

    revokeSender(senderId: number): void {
      for (const [key, grant] of grants) {
        if (grant.senderId === senderId) revoke(key, grant);
      }
    },

    revokeAll(): void {
      for (const [key, grant] of grants) revoke(key, grant);
    },
  };
}

export type SitePreviewSdkAuthorityRegistry = ReturnType<
  typeof createSitePreviewSdkAuthorityRegistry
>;
