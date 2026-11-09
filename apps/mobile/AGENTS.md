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
`EXPO_PUBLIC_DOHC_SAMPLE=1`, as the simulator tests are (`src/sampleBuild.ts`). Any other build shows one screen
saying it can't connect to a server yet, so an installable build never presents sample data as someone's work. A
sample build may keep a control the server will drive later. `src/notices/rowAccessibility.test.ts` holds that each
action a Notices row offers has a handler.

Copy uses React Native's core `Clipboard`, which React Native marks deprecated. Switch `src/copy.ts` to
expo-clipboard before an upgrade removes it.
