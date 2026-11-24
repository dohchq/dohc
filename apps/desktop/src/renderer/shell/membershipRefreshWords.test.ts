import { describe, expect, it } from "vitest";
import { membershipRefreshFailure } from "./membershipRefreshWords";

describe("a joined workspace's refresh failure", () => {
  it("says the workspace could not sync, with the workspace's name last, names the account signed in now, and offers Switch account", () => {
    const error = Object.assign(new Error("Sign in to the account that received this share."), {
      errorKind: "unauthorized",
    });
    expect(
      membershipRefreshFailure({ workspaceName: "Lisbon trip", signedInEmail: "bo@test", error }),
    ).toEqual({
      title: "dohc could not sync Lisbon trip",
      message: "This computer is signed in as bo@test, not the account the owner invited.",
      switchAccount: true,
    });
    expect(
      membershipRefreshFailure({ workspaceName: "Lisbon trip", signedInEmail: null, error }),
    ).toMatchObject({
      message: "This computer is signed in to a different account than the one the owner invited.",
    });
  });

  it("names the workspace, not a shared view, for any other failure", () => {
    const error = Object.assign(new Error("offline"), { errorKind: "transient" });
    expect(
      membershipRefreshFailure({ workspaceName: "Lisbon trip", signedInEmail: "bo@test", error }),
    ).toEqual({ fallback: "dohc could not refresh Lisbon trip." });
  });
});
