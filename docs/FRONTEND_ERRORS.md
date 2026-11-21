# Frontend error handling

## Current behavior

The router uses `RouteErrorPage` for unknown URLs and uncaught route failures. Unknown URLs offer a link back to Fit Tempo, and route failures offer reload. These pages share the branded `StatusPage` with the session check, session recovery and missing password reset link. Pending session checks announce their status and respect reduced-motion preferences. Protected requests in `apps/web/src/lib/api/session.ts` retain HTTP status and an API code for some failures, but generally discard the request ID and conflict revision. Individual screens decide how to display errors. Analytics renders a query error inside its comparison card. The session layer manages authentication transitions and account-scoped cache isolation.

## Proposed recovery patterns

| Situation | What the user sees | Recovery |
| --- | --- | --- |
| Unknown URL | “Page not found” | Go to Today if signed in, or to sign-in from public screens |
| Route crash | “This page didn’t load” | Reload or leave the page using a safe destination |
| Failed read | “We couldn’t load your meals” | Retry the affected query in place |
| Invalid field | A specific instruction next to the field | Correct the field and submit again |
| Stale revision | “This plan changed while you were editing” | Load the latest version, keep the draft where safe, and review again |
| Timed-out write | “We couldn’t confirm whether your changes were saved” | Check the latest state or use the existing receipt-backed retry |
| Rate limit or provider outage | A short status and available fallback | Wait, retry the read when appropriate, or use manual entry |

Use short, feature-specific copy from trusted frontend mappings. Treat non-JSON responses, malformed envelopes, and unknown API codes as recoverable fallbacks. Suppress intentional cancellation. Keep existing authorized data visible during a failed background refresh and label it when stale. Preserve drafts within the current account session and preserve cache isolation when identity changes.

Use linked field messages and `aria-invalid` for inputs. Announce newly displayed in-place errors once. Move focus to a page heading when navigation replaces the page with an error. Keep retry buttons reachable at 320px, allow messages to wrap, and preserve the solid canvas, theme tokens, and navigation behavior. A validated request ID can be shown as a copyable reference when it helps diagnose an unexpected failure.

See the [implementation prompt](ERROR_UI_PROMPT.md) and [backend error guide](BACKEND_ERRORS.md).
