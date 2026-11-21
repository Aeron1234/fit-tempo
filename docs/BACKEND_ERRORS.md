# Backend error handling

## Current behavior

Express endpoints generally return an `error` envelope with `code`, `message`, and `requestId`. Some revision-aware endpoints also return `currentRevision`. The strict shared schema in `packages/contracts/src/common.ts` defines the existing code set and a UUID request ID. The app has a JSON 404 fallback and a generic 500 handler. JSON parsing currently runs before request ID assignment. Parser failures can therefore reach the 500 handler without an assigned request ID.

## Proposed normalization

- Assign the server-generated request ID before middleware that can fail. Normalize recognized malformed JSON and oversized JSON into the existing 400 and 413 codes. Pass errors onward if headers were already sent.
- Preserve the existing response envelope and status/code mappings. Keep feature-specific errors, revision metadata, provider limits, and resource visibility semantics intact. A hidden resource should remain indistinguishable from an absent resource where the current contract requires it.
- Expose only safe messages and validated metadata. Correlate unexpected failures with the request ID using sanitized server-side logs or existing telemetry. Exclude credentials, cookies, request bodies, personal health data, and raw provider messages.
- Retain account verification and recovery privacy. Preserve the existing session refresh and CSRF behavior. Treat a timeout after a state-changing operation as an unknown outcome until existing state or a durable receipt confirms it.
- Use valid retry metadata when supplied by the enforcing layer. Keep rate limiting distinct from unavailable limiter storage and provider outages.

Verify representative 400, 401, 403, 404, 409, 413, 429, 500, and 503 responses. Cover pre-routing parser errors, authorized conflict metadata, privacy, and retry receipts where applicable. See the [wire contract](CONTRACTS.md), [frontend error guide](FRONTEND_ERRORS.md), and [implementation prompt](ERROR_UI_PROMPT.md).
