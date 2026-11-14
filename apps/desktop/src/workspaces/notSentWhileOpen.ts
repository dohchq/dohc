/**
 * Each workspace's new notes whose first file waits for their open editor to
 * be left, as the engine answered after the last sync pass, so a status read
 * never asks the engine. A failed read keeps the last answer.
 */
export function createNotSentWhileOpen() {
  const paths = new Map<string, readonly string[]>();
  return {
    // Answers whether the paths changed.
    async read(workspaceId: string, read: () => Promise<readonly string[]>): Promise<boolean> {
      try {
        const next = await read();
        if (next.join("\0") === (paths.get(workspaceId) ?? []).join("\0")) return false;
        if (next.length) paths.set(workspaceId, next);
        else paths.delete(workspaceId);
        return true;
      } catch (error) {
        console.error("[desktop] notes not sent read failed:", error);
        return false;
      }
    },
    paths: (workspaceId: string): readonly string[] => paths.get(workspaceId) ?? [],
  };
}
