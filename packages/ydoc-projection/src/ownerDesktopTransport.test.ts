import { it } from "vitest";
import { engine, ownerDesktopTransport } from "./ownerDesktopTransport.fixture.js";

it.skipIf(engine.missing).each([{standalone: false, link: false}])(
  "keeps the ordinary desktop owner through authenticated adoption, durable outbox delivery, remote apply and settlement (standalone=$standalone, link=$link)",
  ownerDesktopTransport,
  120_000,
);
