import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

type WriteFamilies = typeof import("@dohc/workspace-contracts/all-write-declarations");

afterEach(() => {
  vi.doUnmock("@dohc/workspace-contracts/all-write-declarations");
  vi.resetModules();
});

// The socket checks a path only in a verb's hand-written rebase case.
it("refuses a declared write whose socket input names a path", async () => {
  vi.resetModules();
  vi.doMock("@dohc/workspace-contracts/all-write-declarations", async (importOriginal) => {
    const { WRITE_DECLARATION_FAMILIES: families } = await importOriginal<WriteFamilies>();
    const { restoreProtectedCopy } = families.protectedCopy;
    return {
      WRITE_DECLARATION_FAMILIES: {
        ...families,
        protectedCopy: {
          restoreProtectedCopy: {
            ...restoreProtectedCopy,
            socket: {
              ...restoreProtectedCopy.socket,
              input: restoreProtectedCopy.socket.input.extend({ path: z.string() }),
            },
          },
        },
      },
    };
  });
  await expect(import("./cliServer")).rejects.toThrow(
    "restoreProtectedCopy input names path. The socket rebases no path of a declared write.",
  );
});
