/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as agentProviders from "../agentProviders.js";
import type * as atomAccess from "../atomAccess.js";
import type * as atomCapture from "../atomCapture.js";
import type * as atomId from "../atomId.js";
import type * as atomLocks from "../atomLocks.js";
import type * as atomShares from "../atomShares.js";
import type * as atomSuggestions from "../atomSuggestions.js";
import type * as atoms from "../atoms.js";
import type * as auth from "../auth.js";
import type * as captures from "../captures.js";
import type * as confirmTier from "../confirmTier.js";
import type * as crons from "../crons.js";
import type * as devReset from "../devReset.js";
import type * as entities from "../entities.js";
import type * as entityId from "../entityId.js";
import type * as folders from "../folders.js";
import type * as formulaEval from "../formulaEval.js";
import type * as graph from "../graph.js";
import type * as hocuspocusAdmin from "../hocuspocusAdmin.js";
import type * as hocuspocusAuth from "../hocuspocusAuth.js";
import type * as htmlAtoms from "../htmlAtoms.js";
import type * as inlineAtom from "../inlineAtom.js";
import type * as liveTotal from "../liveTotal.js";
import type * as liveTotals from "../liveTotals.js";
import type * as onboarding from "../onboarding.js";
import type * as orgRoles from "../orgRoles.js";
import type * as orgs from "../orgs.js";
import type * as orgsBridge from "../orgsBridge.js";
import type * as queries from "../queries.js";
import type * as resolveWindow from "../resolveWindow.js";
import type * as search from "../search.js";
import type * as searchText from "../searchText.js";
import type * as seed from "../seed.js";
import type * as skillTurnGate from "../skillTurnGate.js";
import type * as skills from "../skills.js";
import type * as skillsMigration from "../skillsMigration.js";
import type * as trash from "../trash.js";
import type * as viewData from "../viewData.js";
import type * as viewPaths from "../viewPaths.js";
import type * as views from "../views.js";
import type * as windows from "../windows.js";
import type * as workspaceSlugs from "../workspaceSlugs.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  agentProviders: typeof agentProviders;
  atomAccess: typeof atomAccess;
  atomCapture: typeof atomCapture;
  atomId: typeof atomId;
  atomLocks: typeof atomLocks;
  atomShares: typeof atomShares;
  atomSuggestions: typeof atomSuggestions;
  atoms: typeof atoms;
  auth: typeof auth;
  captures: typeof captures;
  confirmTier: typeof confirmTier;
  crons: typeof crons;
  devReset: typeof devReset;
  entities: typeof entities;
  entityId: typeof entityId;
  folders: typeof folders;
  formulaEval: typeof formulaEval;
  graph: typeof graph;
  hocuspocusAdmin: typeof hocuspocusAdmin;
  hocuspocusAuth: typeof hocuspocusAuth;
  htmlAtoms: typeof htmlAtoms;
  inlineAtom: typeof inlineAtom;
  liveTotal: typeof liveTotal;
  liveTotals: typeof liveTotals;
  onboarding: typeof onboarding;
  orgRoles: typeof orgRoles;
  orgs: typeof orgs;
  orgsBridge: typeof orgsBridge;
  queries: typeof queries;
  resolveWindow: typeof resolveWindow;
  search: typeof search;
  searchText: typeof searchText;
  seed: typeof seed;
  skillTurnGate: typeof skillTurnGate;
  skills: typeof skills;
  skillsMigration: typeof skillsMigration;
  trash: typeof trash;
  viewData: typeof viewData;
  viewPaths: typeof viewPaths;
  views: typeof views;
  windows: typeof windows;
  workspaceSlugs: typeof workspaceSlugs;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
  workOSAuthKit: import("@convex-dev/workos-authkit/_generated/component.js").ComponentApi<"workOSAuthKit">;
};
