interface SdkAuthorityGrantInput {
  senderId: number;
  generation: number;
  workspaceId: string;
}

interface SdkAuthorityCopy {
  label: string;
  subject: string;
  stale: string;
}

interface StoredGrant<T> {
  input: T;
  subjectKey: string;
  controller: AbortController;
}

export type SdkAuthorityAuthorization<TSubject> = TSubject & {
  senderId: number;
  generation: number;
  activeWorkspaceId: string | undefined;
  workspaceId: string;
};

export function createSdkAuthorityRegistry<
  TGrant extends SdkAuthorityGrantInput,
  TAuthorize extends SdkAuthorityAuthorization<object>,
>(
  copy: SdkAuthorityCopy,
  subjectKeyFor: (input: TGrant | TAuthorize) => string,
  subjectRunning: (input: TAuthorize) => boolean,
) {
  const grants = new Map<string, StoredGrant<TGrant>>();
  const grantKey = (senderId: number, subjectKey: string) =>
    `${senderId}\0${subjectKey}`;

  const revoke = (key: string, grant: StoredGrant<TGrant>) => {
    grants.delete(key);
    grant.controller.abort();
  };

  return {
    register(input: TGrant): TGrant & { signal: AbortSignal } {
      const subjectKey = subjectKeyFor(input);
      for (const [key, grant] of grants) {
        if (grant.subjectKey === subjectKey) revoke(key, grant);
      }
      const controller = new AbortController();
      grants.set(grantKey(input.senderId, subjectKey), {
        input: { ...input },
        subjectKey,
        controller,
      });
      return { ...input, signal: controller.signal };
    },

    authorize(input: TAuthorize): TGrant & { signal: AbortSignal } {
      if (input.activeWorkspaceId !== input.workspaceId) {
        throw new Error(
          `${copy.label} request does not target this renderer's active workspace.`,
        );
      }
      const key = grantKey(input.senderId, subjectKeyFor(input));
      const grant = grants.get(key);
      if (!grant) {
        throw new Error(
          `${copy.label} request does not belong to an active ${copy.subject} in this renderer.`,
        );
      }
      if (grant.input.generation !== input.generation) {
        revoke(key, grant);
        throw new Error(copy.stale);
      }
      if (!subjectRunning(input)) throw new Error(copy.stale);
      return { ...grant.input, signal: grant.controller.signal };
    },

    revokeSubject(subjectKey: string): void {
      for (const [key, grant] of grants) {
        if (grant.subjectKey === subjectKey) revoke(key, grant);
      }
    },

    revokeSender(senderId: number): void {
      for (const [key, grant] of grants) {
        if (grant.input.senderId === senderId) revoke(key, grant);
      }
    },

    revokeAll(): void {
      for (const [key, grant] of grants) revoke(key, grant);
    },
  };
}
