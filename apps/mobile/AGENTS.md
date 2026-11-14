# dohc phone app

Read this before changing anything a person sees in the phone app.

## Platform differences

The phone uses the desktop's words and behaviour, which the dohc-interface skill gives (`.agents/skills/dohc-interface/SKILL.md`).
Take shared words from `@dohc/interface-words`. Never copy them.
[The phone app](../../.agents/skills/dohc-interface/phone.md#the-phone-app) in the skill lists what the phone does differently from the desktop.
If a phone word or behaviour differs from the desktop, add it to that list, with its reason, in the PR that introduces it.
If a difference changes what another surface shows, get Ice's decision first.

## Screenshot comparisons

A page's last pixel row at the screen's bottom edge, under the home indicator, can differ by a third of a point from the approved frames.
Accept that difference. Look again only if it shows on another page or grows.

## Android

On iOS the sync band on Notices and Sharing sits in a small native host (`modules/bar-band`), through
`src/notices/useSyncBandHost.tsx`. It tells iOS the band's strip is covered, keeps the band on the list's top edge but
never above the folded bar, has VoiceOver read the band before the list, and reports the space between the bar and the
tab bar. The band is at most half that space, and scrolls inside itself when its text is taller. Android doesn't have
the host yet. There the screen draws the band at the bar's reported height, the list keeps an empty first row of the
band's height, and the band has no height cap. The reading order and a focused row's place aren't handled. Nothing on
Android has been run since the host was added.

## Controls that act

The app shows its sample data only in a sample build: a development build, or one made with `EXPO_PUBLIC_DOHC_SAMPLE=1`, as the simulator tests are (`src/sampleBuild.ts`).
Any other build signs in to a server first (`src/account/Connect.tsx`), then reads the open workspace from it, read-only: Home, Chats, a chat and a page (`src/server/workspaceData.ts`). It reads and marks the account's Notices.
Search shows "Not built yet".

- An installable build never presents sample data as someone's work, and its bundle holds none. Import a sample module (`sample.ts`, or a screen in `Sample*.tsx`) elsewhere only as a type, or require it behind the exact test `src/sampleBuild.ts` gives.
- A sample build may keep a control the server will drive later.
- A link can open any route. Export build-specific screens through `sampleOnly` or `signedInOnly` (`src/sampleOnly.tsx`). `src/routes.test.ts` checks this and rejects other sample-module imports.
- `src/notices/rowAccessibility.test.ts` holds that each action a Notices row offers has a handler.

## Server reads

The server client is in `src/server`. Its files hold how each part works.

- Check `SignIn.isCurrent()` before applying anything a request answered. A sign-in's generation changes at sign-out, at a 401 and when another sign-in starts, and the change aborts that sign-in's requests (`src/server/account.ts`).
- Use `requestGenerations()` for results that replace each other (`src/server/client.ts`).
- The open workspace's reads live in one store per sign-in and workspace. The store stops when either changes, so a late answer can't reach another workspace's screen (`src/server/workspaceData.ts`).
- The phone opens only workspaces the list marks `canOpen`. A 404 for the open workspace clears and stops its store, and the phone reads its workspace list again (`src/server/openWorkspace.ts`).
- The read cache keeps a copy on disk in Caches, so a relaunch opens the last workspace from disk before the server answers. `src/server/cacheFiles.ts` and the `ReadCache` in `src/server/workspaceData.ts` hold when it writes and deletes its files.
- Raise `CACHE_FORMAT` when a view's value changes shape.
- The account's Notices live in one store per sign-in, beside the workspace list, not in the open workspace's (`src/server/noticeStore.ts`). It reads the whole list again at each start, return from the background, refresh, and change to which workspaces show on the phone. Its waiting marks are in two alternating slot files in Documents, never moved over each other (`src/server/noticeFiles.ts`). Raise `NOTICE_LIST_FORMAT` or `NOTICE_MARKS_FORMAT` when a file's shape changes.
- Ending a token deletes it from the keychain first, then revokes its session, so a phone closed between the two keeps no token (`src/server/account.ts`).

## Copy

`src/copy.ts` uses React Native's core `Clipboard`, which React Native marks deprecated.
Before an upgrade removes it, switch `src/copy.ts` to expo-clipboard.
