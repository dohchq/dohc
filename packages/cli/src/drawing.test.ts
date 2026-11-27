import { describe, expect, it, vi } from "vitest";
import { executeCli } from "./index";

describe("drawing commands", () => {
  it.each(['{"path":"other.excalidraw","delete":[]}', '{"requestId":"r1","delete":[]}'])(
    "refuses edit-json that holds a path or request id: %s",
    async (edit) => {
      const request = vi.fn();
      const result = await executeCli({
        argv: ["drawing", "edit", "plan.excalidraw", edit],
        request,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("edit-json cannot hold path or requestId");
      expect(request).not.toHaveBeenCalled();
    },
  );
});
