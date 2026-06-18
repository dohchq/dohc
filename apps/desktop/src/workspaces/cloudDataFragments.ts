import {
  CreateDataFragmentResult,
  ListDataFragmentsResult,
  ReadDataFragmentResult,
  type CreateDataFragmentPayload,
  type CreateDataFragmentResult as CreateDataFragmentResultType,
  type ListDataFragmentsResult as ListDataFragmentsResultType,
  type ReadDataFragmentResult as ReadDataFragmentResultType,
} from "../ipc/bridgeContract";

type CloudJson = <T>(path: string, init?: RequestInit) => Promise<T>;

export function createCloudDataFragment(
  cloudJson: CloudJson,
  remoteWorkspaceId: string,
  input: CreateDataFragmentPayload,
): Promise<CreateDataFragmentResultType> {
  return cloudJson(
    `/workspaces/${encodeURIComponent(remoteWorkspaceId)}/data-fragments`,
    {
      method: "POST",
      body: JSON.stringify({
        sourcePath: input.sourcePath,
        title: input.title,
        contentType: input.contentType,
        body: input.body,
        recipientEmail: input.recipientEmail,
      }),
    },
  ).then((result) => CreateDataFragmentResult.parse(result));
}

export function listCloudDataFragments(
  cloudJson: CloudJson,
): Promise<ListDataFragmentsResultType> {
  return cloudJson("/me/data-fragments").then((result) =>
    ListDataFragmentsResult.parse(result),
  );
}

export function readCloudDataFragment(
  cloudJson: CloudJson,
  fragmentId: string,
): Promise<ReadDataFragmentResultType> {
  return cloudJson(`/data-fragments/${encodeURIComponent(fragmentId)}`).then(
    (result) => ReadDataFragmentResult.parse(result),
  );
}

export async function revokeCloudDataFragment(
  cloudJson: CloudJson,
  fragmentId: string,
): Promise<void> {
  await cloudJson(`/data-fragments/${encodeURIComponent(fragmentId)}`, {
    method: "DELETE",
  });
}
