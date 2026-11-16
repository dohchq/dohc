import { expect, it } from "vitest";
import { createLinkSessionSeal } from "./linkSessionSeal";

const seal = createLinkSessionSeal(Buffer.alloc(32, 5).toString("base64url"));
const session = {
  grantId: "grant-alpha",
  capabilityToken: Buffer.alloc(32, 1).toString("base64url"),
  expiresAtMs: 901_000,
  sealedBy: "process-a",
};

it("opens its own seal beside the binding it was made for, and no other", () => {
  const sealed = seal.seal("link:token", session);
  expect(seal.unseal("link:token", sealed)).toEqual(session);
  expect(seal.unseal("link:other", sealed)).toBeNull();
  expect(sealed).not.toContain(session.capabilityToken);
  expect(seal.seal("link:token", session)).not.toBe(sealed);
});

it("refuses every other spelling of a seal's bytes", () => {
  // The last character of a base64url text can carry bits its bytes do not use. Some grant id gives such a text.
  for (let pad = 0; pad < 3; pad++) {
    const sealed = seal.seal("link:token", { ...session, grantId: `grant-${"x".repeat(pad)}` });
    const bytes = Buffer.from(sealed, "base64url");
    const others = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"]
      .map((last) => sealed.slice(0, -1) + last)
      .filter((other) => other !== sealed && Buffer.from(other, "base64url").equals(bytes));
    if (others.length === 0) continue;
    for (const other of others) expect(seal.unseal("link:token", other)).toBeNull();
    return;
  }
  throw new Error("no seal had a second spelling");
});

it.each(["", "!", "a".repeat(40), "a".repeat(2_000), "é", "AAAA.AAAA"])(
  "refuses %j without throwing",
  (value) => {
    expect(seal.unseal("link:token", value)).toBeNull();
  },
);
