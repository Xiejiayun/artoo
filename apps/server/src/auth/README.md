# Trusted team authentication

Production always enforces REST authentication. Configure Google OIDC credentials
and `AUTH_OWNER_EMAILS` (comma-separated verified owner addresses), plus either
`AUTH_ALLOWED_EMAILS` (comma-separated team addresses) or `GOOGLE_HOSTED_DOMAIN`
(a Google Workspace hosted-domain claim). When both access policies are set,
both must match. Owners must belong to the configured access policy. Emails are
normalized to lowercase. Unknown identities cannot join an explicitly restricted
team. Removing an email from the allowlist rejects its existing sessions and
paired control credentials on subsequent requests.

Web uses the existing Google sign-in and HttpOnly session cookie. Production
cookies are Secure. Use HTTPS for the server and the registered OAuth callback.
Do not copy a session token into an application setting or URL.

Native Windows/macOS/iOS onboarding:

1. An authenticated team member creates a code for their own identity with
   `POST /api/v1/devices/pairings`, optionally setting `intended_platform`.
   Sign in as the person who will use the client. Never share a code with
   another person: it grants the creating user's access, including their role.
2. The native app submits the code, `platform`, `app_version`, and `display_name`
   to `POST /api/v1/devices/claim`. This is the only public device REST endpoint;
   its single-use code is short-lived and claim attempts are rate limited.
3. Store returned `control_token` in Windows encrypted storage or iOS Keychain.
   Use `Authorization: Bearer <control_token>` on REST, `/auth/session`, and the
   WebSocket upgrade. Do not put bearer tokens in query strings. The associated
   user is the authenticated person who created the pairing code.
   Browser/Electron WebSocket APIs use protocols
   `["artoo", "artoo-auth." + controlToken]` instead of a bearer header. The
   server negotiates only `artoo`, never echoes the credential, and rejects
   malformed or multiple authentication protocols.
4. `/auth/session` returns `{user: {id, email, name, role}, device_id}` for paired
   credentials. A device credential can perform the same permitted actions as
   its enrolling user. Only owner/admin can enroll execution hosts, install
   skills, change projects or configure agent instances. Members can pair their
   own clients and revoke their own devices; unrelated member devices are protected.
5. An owner/admin authorizes a desktop execution host with
   `POST /api/v1/devices/:id/enroll`. A member's paired desktop can use the control
   application before enrollment, but its worker cannot connect until an
   administrator enrolls it. Retain `node_token` separately for the compute daemon.
   Node tokens never authenticate control REST or WebSocket.
6. `POST /auth/logout` with the control bearer revokes that control credential;
   clear secure client storage and close its WebSocket. Server wiring also
   closes existing control sockets for that device, leaving compute credentials
   and compute sockets active. Full device revoke revokes both credentials.

Native control tokens expire after 30 days by default; set
`ARTOO_CONTROL_TOKEN_TTL_MS` to another positive duration. Expired credentials
require pairing again. Cookies and user-session bearers are also supported for
existing authenticated clients. An invalid Authorization header always fails,
even if a valid cookie accompanies it. Existing control WebSockets revalidate
their credential at least every 30 seconds, so expiry, user-session logout,
external revocation, and team allowlist changes close them within that bound.

The only other authentication-guard exemptions are the exact GET WebSocket
routes and the exact PUT node artifact-upload route. Those endpoints implement
their own node/control authentication. Similar URL prefixes are protected.
Non-production anonymous development fixtures remain available when API auth
is deliberately disabled, but supplied invalid credentials are still rejected.
