import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/signed-out')({
  component: SignedOut,
})

function SignedOut() {
  return (
    <div className="centered">
      <div className="signin-card">
        <pre className="signin-logo">{`  vibeam

  signed out.`}</pre>
        <a className="signin-button" href="/api/auth/sign-in">
          sign in again
        </a>
      </div>
    </div>
  )
}
