import type { ReactNode } from 'react'
import {
  Outlet,
  HeadContent,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { ConvexProviderWithAuth } from 'convex/react'
import { AuthKitProvider } from '@workos/authkit-tanstack-react-start/client'
import { convexClient } from '@/lib/convex-client'
import { useAuthForConvex } from '@/lib/use-auth-bridge'
import '@/styles.css'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'dohc' },
      {
        name: 'description',
        content:
          'The quiet AI and docs workspace where work becomes clear, traceable, and ready.',
      },
      // Warm paper in light mode, green-black in dark mode.
      {
        name: 'theme-color',
        content: '#f7f6f1',
        media: '(prefers-color-scheme: light)',
      },
      {
        name: 'theme-color',
        content: '#100f0e',
        media: '(prefers-color-scheme: dark)',
      },
      { property: 'og:title', content: 'dohc' },
      {
        property: 'og:description',
        content: 'The quiet AI and docs workspace.',
      },
      { property: 'og:image', content: '/og-image.svg' },
    ],
    links: [
      // dohc drop-lobe favicon — SVG so it stays crisp at every size
      // and adapts to prefers-color-scheme (see public/favicon.svg).
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.svg' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <AuthKitProvider>
        <ConvexProviderWithAuth client={convexClient} useAuth={useAuthForConvex}>
          <Outlet />
        </ConvexProviderWithAuth>
      </AuthKitProvider>
    </RootDocument>
  )
}

// Inline script that runs before React hydrates — reads the persisted
// theme choice from localStorage and applies it to <html data-theme>
// so there's no flash of the wrong palette on first paint.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('dohc-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
