// Convex auth provider configuration.
//
// WorkOS access tokens are RS256 JWTs whose `iss` is per-application
// (`https://api.workos.com/user_management/<client_id>`). The issuer URL
// itself uniquely identifies our WorkOS app, so issuer-only matching
// is the correct posture — WorkOS doesn't put an `aud` claim in access
// tokens, so a strict `applicationID` match would always fail.
//
// Required env on the Convex deployment:
//   WORKOS_CLIENT_ID
export default {
  providers: [
    {
      type: 'customJwt' as const,
      issuer: `https://api.workos.com/user_management/${process.env.WORKOS_CLIENT_ID}`,
      jwks: `https://api.workos.com/sso/jwks/${process.env.WORKOS_CLIENT_ID}`,
      algorithm: 'RS256' as const,
    },
  ],
}
