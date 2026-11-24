import { afterEach, expect, it } from "vitest";
import {
  appendLog,
  closeTestStorages,
  json,
  jsonBody,
  linkSecret,
  moment,
  putBlob,
  request,
  linkRequest,
  sha256,
  testHandler,
  testStorage,
} from "./testing";

const OWNER = "owner";
const WORKSPACE = "workspace-forked-note";
const PATH = "docs/note.md";
const EXCHANGE_KEY = "forked-note-relay-exchange-key-at-least-32";

afterEach(closeTestStorages);

it("a view link shows a note's latest save after two saves fork from one state and the chain continues from the side that lost", async () => {
  const h = testHandler(await testStorage(), {
    resolveUserIdByEmail: undefined,
    lookupUserEmail: undefined,
    lookupVerifiedUserEmail: undefined,
    relayExchangeKey: EXCHANGE_KEY,
  });
  expect(
    (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
  ).toBe(200);
  const text = {
    created: "# note\n",
    settled: "# note\nsettled\n",
    winner: "# note\nsettled\nwinner\n",
    winnerNext: "# note\nsettled\nwinner\nnext\n",
    loser: "# note\nsettled\nloser\n",
    loserSave: "# note\nsettled\nloser\nsaved\n",
    latest: "# note\nsettled\nloser\nsaved\nevery word\n",
  };
  for (const content of Object.values(text)) await putBlob(h, OWNER, WORKSPACE, content);
  const save = (
    originSeq: number,
    momentId: string,
    before: string | null,
    beforeMomentId: string | null,
    after: string,
  ) =>
    moment(PATH, after, {
      originSeq,
      recordedAtMs: 1_000 + originSeq,
      momentId,
      objectId: "note",
      beforePath: before === null ? null : PATH,
      beforeContent: before,
      payload: before === null ? {} : { beforeLatestMomentId: beforeMomentId },
    });

  await appendLog(h, OWNER, WORKSPACE, [
    save(0, "m-created", null, null, text.created),
    save(1, "m-settled", text.created, "m-created", text.settled),
    save(2, "m-winner", text.settled, "m-settled", text.winner),
    save(3, "m-winner-next", text.winner, "m-winner", text.winnerNext),
  ]);
  await appendLog(
    h,
    OWNER,
    WORKSPACE,
    [
      save(0, "m-loser", text.settled, "m-settled", text.loser),
      save(1, "m-loser-save", text.settled, "m-settled", text.loserSave),
      save(2, "m-latest", text.loserSave, "m-loser-save", text.latest),
    ],
    { originId: "origin-b" },
  );

  const share = await json(
    await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientUserId: "recipient", paths: ["docs"], access: "view" }),
      ),
    ),
  );
  const link = await json(
    await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/${String(share.shareId)}/links`,
        jsonBody({ access: "view" }),
      ),
    ),
  );
  const exchange = await json(
    await h(
      request(null, "/sync/link-exchange", {
        ...jsonBody({ secret: linkSecret(link.url) }),
        headers: { "content-type": "application/json", "x-dohc-relay-exchange-key": EXCHANGE_KEY },
      }),
    ),
  );
  const current = await json(
    await h(linkRequest(String(exchange.capabilityToken), "/sync/link/current")),
  );

  expect(current.files).toEqual([
    expect.objectContaining({ path: PATH, blobSha256: sha256(text.latest) }),
  ]);
});
