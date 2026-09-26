import { RelayIdentityMissingError } from "@dohc/workspace-contracts/relay";

export async function pushWithIdentity<Result>(operations: {
  push(): Promise<Result>;
  claim(): Promise<void>;
}): Promise<Result> {
  return operations.push().catch(async (error: unknown) => {
    if (!(error instanceof RelayIdentityMissingError)) throw error;
    await operations.claim();
    return operations.push();
  });
}
