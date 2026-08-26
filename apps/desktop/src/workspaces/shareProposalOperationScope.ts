export interface ShareProposalOperationScope<Scope> {
  resolve(): Scope;
  assert(scope: Scope): void;
}

export function createShareProposalOperationScope<Scope>(input: {
  resolve(): Scope;
  same(left: Scope, right: Scope): boolean;
  changedMessage: string;
}): ShareProposalOperationScope<Scope> {
  return Object.freeze({
    resolve: input.resolve,
    assert(scope: Scope) {
      if (!input.same(scope, input.resolve())) {
        throw new Error(input.changedMessage);
      }
    },
  });
}
