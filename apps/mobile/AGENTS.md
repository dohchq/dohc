# dohc phone app

Read this before changing anything a person sees in the phone app. The phone uses the desktop's words and
behaviour (`.agents/skills/dohc-interface/SKILL.md`), from `@dohc/interface-words` where they're shared. A
phone word or behaviour that differs from the desktop goes in the skill's phone section, with its reason, in the PR
that introduces it. A difference that changes what another surface shows needs Ice's decision first.

## Platform differences

What the phone does differently from the desktop is listed in the dohc-interface skill's phone section (`.agents/skills/dohc-interface/SKILL.md`, "The phone app"). Add a new difference there, with its reason, in the PR that introduces it.

## Screenshot comparisons

A page's last pixel row at the screen's bottom edge, under the home indicator, can differ by a third of a point from
the approved frames. It's a known difference; look again only if it shows on another page or grows.

## Android

On iOS the sync band on Notices and Sharing sits in a small native host (`modules/bar-band`), through
`src/notices/useSyncBandHost.tsx`. It tells iOS the band's strip is covered, keeps the band on the list's top edge but
never above the folded bar, has VoiceOver read the band before the list, and reports the space between the bar and the
tab bar. The band is at most half that space, and scrolls inside itself when its text is taller. Android doesn't have
the host yet. There the screen draws the band at the bar's reported height, the list keeps an empty first row of the
band's height, and the band has no height cap. The reading order and a focused row's place aren't handled. Nothing on
Android has been run since the host was added.

## Controls that act

The app shows its sample data only in a sample build: a development build, or one made with
`EXPO_PUBLIC_DOHC_SAMPLE=1`, as the simulator tests are (`src/sampleBuild.ts`). Any other build signs in to a
server first (`src/account/Connect.tsx`), then reads the open workspace from it, read-only: Home, Chats, a chat and a
page (`src/server/workspaceData.ts`). Search shows "Not built yet". An installable build never presents sample data
as someone's work, and its bundle holds none: a sample module (`sample.ts`, or a screen in `Sample*.tsx`) is imported
elsewhere only as a type, or required behind the exact test `src/sampleBuild.ts` gives. A sample build may keep a
control the server will drive later. A link can open any route, so a route for one kind of build exports its screen
through `sampleOnly` or `signedInOnly` (`src/sampleOnly.tsx`), and `src/routes.test.ts` fails on a route that does
neither, and on a sample module imported any other way. `src/notices/rowAccessibility.test.ts` holds that each action a Notices row offers
has a handler.

The server client (`src/server`) gives each sign-in a generation, which changes at sign-out, at a 401 and when
another sign-in starts. A change aborts that sign-in's requests. Check `SignIn.isCurrent()` before applying anything
a request answered, and use `requestGenerations()` for results that replace each other. The open workspace's reads
live in one store per sign-in and workspace, which stops when either changes, so a late answer can't reach another
workspace's screen. A 404 for the workspace, as when another device hides it from the phone, clears and stops its
store, and the phone reads its workspace list again (`src/server/openWorkspace.ts`). If the list still shows it and
the server can open it, it stays open as a failed read until Try again; otherwise the phone opens the next one. The
phone opens only workspaces the list marks `canOpen`. The read cache is in memory
and empties when the sign-in changes or ends, and loses a workspace when the phone hides it. Ending a token deletes it from
the keychain first, then revokes its session, so a phone closed between the two keeps no token.

Copy uses React Native's core `Clipboard`, which React Native marks deprecated. Switch `src/copy.ts` to
expo-clipboard before an upgrade removes it.
