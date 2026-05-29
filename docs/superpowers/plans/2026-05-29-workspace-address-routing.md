# Workspace Address Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build workspace-scoped email routing and pending shares so one account can safely operate personal and work workspaces.

**Architecture:** Extend existing Convex `auth`, `atomShares`, `orgs`, and schema modules instead of introducing a separate identity subsystem. Keep the MVP additive: one verified route per normalized email, pending shares for unresolved email targets, and workspace-scoped UI copy.

**Tech Stack:** Convex, convex-test, React, Vitest, lucide-react, Tailwind utility classes.

---

## Task 1: Backend Routing Tables And Tests

**Files:**
- Modify: `apps/app/convex/schema.ts`
- Modify: `apps/app/convex/auth.ts`
- Modify: `apps/app/convex/atomShares.test.ts`
- Modify: `apps/app/convex/atomShares.ts`

- [x] Write failing tests for routed email sharing, pending share creation, and pending share acceptance.
- [x] Add additive schema tables and indexes.
- [x] Add mutations/queries for routing current signed-in email.
- [x] Update `shareAtomByEmail` to return either a granted share or a pending share.
- [x] Add pending-share list and accept mutations.
- [x] Run `pnpm --filter @dohc/app test convex/atomShares.test.ts`.

## Task 2: Workspace Identity Projection

**Files:**
- Modify: `apps/app/convex/orgs.ts`
- Modify: `apps/app/convex/orgs.test.ts`

- [x] Add address route and billing summary fields to `myWorkspaces`.
- [x] Add member profile labels to `orgMembers`.
- [x] Test that workspaces can exist with no route and that members do not render as raw ids when a profile exists.
- [x] Run `pnpm --filter @dohc/app test convex/orgs.test.ts`.

## Task 3: Share Copy And Dialog UX

**Files:**
- Modify: `apps/app/src/components/shareDialogCopy.ts`
- Modify: `apps/app/src/components/shareDialogCopy.test.ts`
- Modify: `apps/app/src/components/ShareDialog.tsx`

- [x] Update copy tests for workspace identity and pending behavior.
- [x] Surface routed/pending share results in the share dialog.
- [x] Add pending inbox rows for the signed-in email.
- [x] Run `pnpm --filter @dohc/app test src/components/shareDialogCopy.test.ts`.

## Task 4: Workspace Management UX

**Files:**
- Modify: `apps/app/src/components/WorkspaceManagementDialog.tsx`

- [x] Show account/workspace/billing language in the dialog header.
- [x] Show optional address routes per workspace.
- [x] Add a route-current-email action for each workspace.
- [x] Replace raw member ids with member profile labels.

## Task 5: Verification

**Files:**
- No new production files.

- [x] Run targeted backend tests.
- [x] Run targeted frontend copy tests.
- [x] Run app typecheck if local Node tooling supports it.
- [x] Report any environmental limitations explicitly.
