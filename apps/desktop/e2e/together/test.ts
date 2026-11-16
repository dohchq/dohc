import { test as base } from "@playwright/test";
import { startTogetherStack, type TogetherStack } from "./stack";

/** A test with a self-hosted server of its own. A failure keeps what the services said. */
export const test = base.extend<{ stack: TogetherStack }>({
  stack: async ({}, use, info) => {
    const stack = await startTogetherStack();
    try {
      await use(stack);
    } finally {
      if (info.status !== info.expectedStatus)
        await info.attach("services", { contentType: "text/plain", body: stack.output() });
      await stack.close();
    }
  },
});
