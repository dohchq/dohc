export function requireCredentials<Credentials>(
  credentials: Credentials | null,
  ErrorType: new (message: string) => Error = Error,
): Credentials {
  if (credentials === null) throw new ErrorType("Sign in to dohc Cloud first.");
  return credentials;
}

export function credentialScopedOperation(input: {
  assertCurrent(): void;
  capturedGeneration: number;
  currentGeneration(): number;
}) {
  const assertCurrent = (): void => {
    input.assertCurrent();
    if (input.currentGeneration() !== input.capturedGeneration) {
      throw new Error("Your dohc Cloud session changed. Try again.");
    }
  };
  return {
    assertCurrent,
    async run<Result>(work: () => Promise<Result>): Promise<Result> {
      assertCurrent();
      const result = await work();
      assertCurrent();
      return result;
    },
  };
}
