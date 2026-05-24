import { createFileRoute, redirect } from '@tanstack/react-router'

// R1 — bare `/` redirects to `/w/me` (personal workspace home). All
// routes now carry the workspace in the URL; the bare root is a
// shortcut for "my personal workspace home." Legacy bookmarks that
// land on `/` pick up the personal-default behavior naturally.
//
// (When the active workspace was switched to an org in a prior session,
// localStorage still carries that hint — but R1 makes URL the source of
// truth, so landing on `/` consistently means "personal." Users who
// want to land in their org bookmark `/w/<orgId>` directly.)
export const Route = createFileRoute('/_app/')({
  beforeLoad: () => {
    throw redirect({
      to: '/w/$wsId',
      params: { wsId: 'me' },
      replace: true,
    })
  },
  component: () => null,
})
