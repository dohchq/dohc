import type { ComponentType } from "react";
import { NotYet } from "./NotYet";
import { sampleBuild } from "./sampleBuild";

// Routes for one kind of build. A link can open any route, so a route the build has no use for shows "Not built yet"
// instead: a build without sample data never reaches a sample screen, and a sample build never reaches a screen
// that needs a signed-in account. src/routes.test.ts holds that every route is one of these, or works in both builds.

/** A sample screen, which a build without sample data gets as null: it isn't in that build's bundle. */
export function sampleOnly<P extends object>(Screen: ComponentType<P> | null): ComponentType<P> {
  return sampleBuild && Screen ? Screen : NotBuilt;
}

export function signedInOnly<P extends object>(Screen: ComponentType<P>): ComponentType<P> {
  return sampleBuild ? NotBuilt : Screen;
}

function NotBuilt() {
  return <NotYet symbol="hammer" />;
}
