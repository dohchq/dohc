import { runInKeyedLane } from "../keyedLane";

export function runInWorkspaceAuthorityLane<Result>(
  authority: {
    readonly state: { operationLanes: Map<string, Promise<void>> };
    assertCurrent(): void;
  },
  key: string,
  run: () => Promise<Result>,
): Promise<Result> {
  return runInKeyedLane(authority.state.operationLanes, key, async () => {
    authority.assertCurrent();
    const result = await run();
    authority.assertCurrent();
    return result;
  });
}
