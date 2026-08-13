import {
  createSdkAuthorityRegistry,
  type SdkAuthorityAuthorization,
} from "./sdkAuthorityRegistry";

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

interface SitePreviewSubject {
  workspaceId: string;
  siteRoot: string;
}

function subjectKey(input: SitePreviewSubject): string {
  return `${input.workspaceId}\0${input.siteRoot}`;
}

/**
 * Server-side authority for the SDK bridge. A payload naming a workspace and
 * site is never authority by itself: only the renderer that started the live
 * preview receives a grant, and that grant expires with its renderer
 * generation or the preview handle.
 */
export function createSitePreviewSdkAuthorityRegistry() {
  const registry = createSdkAuthorityRegistry<
    SitePreviewSdkGrantInput,
    SdkAuthorityAuthorization<SitePreviewSubject> & { previewRunning: boolean }
  >(
    {
      label: "Site SDK",
      subject: "preview",
      stale: "Site SDK preview authority is stale.",
    },
    subjectKey,
    (input) => input.previewRunning,
  );

  return {
    register: registry.register,
    authorize: registry.authorize,
    revokePreview: (workspaceId: string, siteRoot: string) =>
      registry.revokeSubject(subjectKey({ workspaceId, siteRoot })),
    revokeSender: registry.revokeSender,
    revokeAll: registry.revokeAll,
  };
}

export type SitePreviewSdkAuthorityRegistry = ReturnType<
  typeof createSitePreviewSdkAuthorityRegistry
>;
