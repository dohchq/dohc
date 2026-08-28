import { resolve } from "node:path";
import {
  assertActiveWorkspaceOperationLease,
  type WorkspaceOperationLease,
} from "./workspaceAssets";

const shareViewFilesOwnerCapabilityBrand = Symbol(
  "ShareViewFilesOwnerCapability",
);

export interface ShareViewFilesOwnerCapability {
  readonly [shareViewFilesOwnerCapabilityBrand]: true;
}

export interface ShareViewFilesOwnerResource {
  kind: "standalone" | "mount";
  workspaceId: string;
  storeWorkspaceId: string;
  schedulingRootPath: string;
  rootPath: string;
  shareId: string;
  mountLabel?: string;
}

export type ShareViewFilesOwnerResourceExpectation = Partial<
  ShareViewFilesOwnerResource
>;

const activeShareViewFilesOwners = new WeakMap<
  ShareViewFilesOwnerCapability,
  {
    assertActive: () => void;
    pending: Set<Promise<unknown>>;
    resource: Readonly<ShareViewFilesOwnerResource>;
  }
>();

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

export function assertActiveShareViewFilesOwner(
  owner: ShareViewFilesOwnerCapability,
  expected: ShareViewFilesOwnerResourceExpectation = {},
): Readonly<ShareViewFilesOwnerResource> {
  const active = activeShareViewFilesOwners.get(owner);
  if (active === undefined) {
    throw new Error("Share-view file ownership admission is inactive.");
  }
  active.assertActive();
  const actual = active.resource;
  const matches =
    (expected.kind === undefined || expected.kind === actual.kind) &&
    (expected.workspaceId === undefined ||
      expected.workspaceId === actual.workspaceId) &&
    (expected.storeWorkspaceId === undefined ||
      expected.storeWorkspaceId === actual.storeWorkspaceId) &&
    (expected.shareId === undefined || expected.shareId === actual.shareId) &&
    (expected.mountLabel === undefined ||
      expected.mountLabel === actual.mountLabel) &&
    (expected.schedulingRootPath === undefined ||
      samePath(expected.schedulingRootPath, actual.schedulingRootPath)) &&
    (expected.rootPath === undefined ||
      samePath(expected.rootPath, actual.rootPath));
  if (!matches) {
    throw new Error(
      "Share-view file ownership admission belongs to another target.",
    );
  }
  return actual;
}

export function withActiveShareViewFilesOwnerOperation<T>(
  owner: ShareViewFilesOwnerCapability,
  expected: ShareViewFilesOwnerResourceExpectation,
  operation: () => Promise<T>,
): Promise<T> {
  assertActiveShareViewFilesOwner(owner, expected);
  const admission = activeShareViewFilesOwners.get(owner)!;
  const pending = Promise.resolve().then(operation);
  admission.pending.add(pending);
  void pending.then(
    () => admission.pending.delete(pending),
    () => admission.pending.delete(pending),
  );
  return pending;
}

export async function withShareViewFilesOwner<T>(
  input: {
    resource: ShareViewFilesOwnerResource;
    workspaceLease: WorkspaceOperationLease;
  },
  run: (owner: ShareViewFilesOwnerCapability) => Promise<T>,
): Promise<T> {
  let active = true;
  const owner: ShareViewFilesOwnerCapability = {
    [shareViewFilesOwnerCapabilityBrand]: true,
  };
  activeShareViewFilesOwners.set(owner, {
    resource: Object.freeze({ ...input.resource }),
    pending: new Set(),
    assertActive: () => {
      if (!active) {
        throw new Error("Share-view file ownership admission has ended.");
      }
      assertActiveWorkspaceOperationLease(
        input.resource.schedulingRootPath,
        input.workspaceLease,
      );
    },
  });
  try {
    assertActiveShareViewFilesOwner(owner);
    return await run(owner);
  } finally {
    const admission = activeShareViewFilesOwners.get(owner);
    while (admission !== undefined && admission.pending.size > 0) {
      await Promise.allSettled([...admission.pending]);
    }
    active = false;
    activeShareViewFilesOwners.delete(owner);
  }
}
