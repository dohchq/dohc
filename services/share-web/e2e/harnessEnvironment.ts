const SERVICE_ENVIRONMENT_PREFIXES = ["DOHC_", "SYNC_RELAY_"] as const;

export function buildHarnessEnvironment(
  inherited: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(inherited).filter(([name]) =>
      !SERVICE_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
    ),
  );
  return { ...environment, ...overrides };
}
