import { it } from "vitest";
import { engine, expectTwoDaemonFileSync } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)(
  "syncs a captured secret file between two real daemons through one real relay",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-secret-sync",
      path: ".env",
      contents: "TOKEN=two-daemon-secret\n",
      passphrase: "two-daemon protected-files passphrase",
      restart: { contents: "TOKEN=after-restart\n" },
      rejoin: true,
    }),
  90_000,
);
