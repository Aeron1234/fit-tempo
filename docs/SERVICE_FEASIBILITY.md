# Fit Tempo service feasibility

Reviewed November 16, 2026 (Asia/Manila). Phase 02 only.

Phase 02 research and configuration decisions are documented. Its live-check gate remains partially blocked. Two read-only workers investigated food data and AI/email/cron independently. The lead read the complete architecture and canonical project workflow, integrated findings, and independently retrieved the principal official sources. These are feasibility decisions for subsequent implementation.

## Dated capability matrix

Published allowances below were checked on the review date. Account entitlements remain unverified.

| Service | Published capability and limits | Observed environment or account evidence | Decision and remaining gate |
| --- | --- | --- | --- |
| USDA FoodData Central | Key required. Default 1,000 requests/hour/IP. Public DEMO_KEY allows 30/hour/IP and 50/day/IP. CC0/public domain, source citation requested. Usage headers expose remaining quota. [API guide](https://fdc.nal.usda.gov/api-guide/) | USDA_API_KEY absent. One DEMO_KEY lookup failed DNS before HTTP. | Keep adapter disabled locally. Retry bounded detail/search requests when networking works, then verify the project's own key and headers. |
| Open Food Facts | Introduction recommends v3.6 and marks v2 deprecated. Product reads 15/min/IP, search 10/min/IP. Custom identifying User-Agent required. Use staging for development. [API documentation](https://openfoodfacts.github.io/openfoodfacts-server/api/) | One staging barcode lookup failed DNS before HTTP. No product fields or miss behavior verified. | Plan barcode reads against the current API. Supply a real project contact for the identifying header before live use. Provider-wide cache and budgeting must respect shared backend egress. |
| Gemini | RPM/TPM/RPD limits depend on project/model/tier. AI Studio exposes active allowances, which are not guaranteed capacity. [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) | GEMINI_API_KEY and GEMINI_MODEL absent. Billing, model access, audience and quota unverified. | AI defaults off. A later synthetic call needs an approved fixture, configured model/key and resolved audience gate. |
| EmailJS | /send documents 1 request/second. Free advertises 200 monthly requests and 2 templates. [Send](https://www.emailjs.com/docs/rest-api/send/) · [Plan capacity](https://www.emailjs.com/pricing/) | Service, keys and all five template configuration names absent. Connected sender, security controls, balance and authorized inbox unverified. | Preserve the architecture's separate template mapping. Its full set exceeds Free's template capacity. Resolve live plan capacity before full delivery acceptance. |
| Vercel legacy Cron | Hobby runs each job at most daily, within an hour window. Pro supports minute cadence. Legacy Cron remains documented with future migration to Schedules. [Usage](https://vercel.com/docs/cron-jobs/usage-and-pricing) | CRON_SECRET and SCHEDULER_MODE absent. No vercel.json, linked project or verified plan. | Actual tier is unknown. Local scheduling remains manual dry-run. Daily digest is the design baseline for a later verified Hobby deployment. Finer reminders require verified cadence. |

## Licensing, data and audience decisions

Retain food source identity and attribution. USDA records need their original nutrient basis and validated serving conversion. Unknown nutrients stay null. Food-specific conversions and immutable meal snapshots remain governed by Section 6.1.

OFF licenses database, individual contents and images separately under ODbL, DbCL and CC BY-SA. Include attribution and license links, retain source provenance, and review share-alike obligations before publishing a combined or derived catalog. Source separation alone does not establish license compliance. Image rights also need their own handling. [OFF licensing](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/license-be-on-the-legal-side/)

Gemini unpaid terms prohibit personal, sensitive and confidential submissions and permit improvement/review processing. Terms also restrict clients directed toward or likely accessed by under-18s. Paid access changes data processing terms while the audience condition persists. Resolve provider, audience and data handling before public personalized AI. For unpaid development use only approved nonpersonal images and fictional profiles. [Gemini terms](https://ai.google.dev/gemini-api/terms)

No approved image registry exists yet. Phase 19 must establish fixture IDs and reject arbitrary synthetic-mode uploads in Express before any provider call. AI suggestions stay editable, arithmetic and scheduling stay deterministic, and confirmed logging remains separate.

## Email and scheduler decisions

Phase 06 will inject a test-only in-memory mailbox for verification/reset links and reject that configuration in production. Phase 21 connects EmailJS. Enable non-browser requests and private-key authorization in the provider dashboard, then verify that public-only calls cannot bypass the intended controls. Keep all credentials and recipient/template selection on the server. The Node SDK supports these options. [Node SDK](https://github.com/emailjs-com/emailjs-nodejs)

Template mapping retains verify, reset, security, reminder and summary configuration from Section 17. Resolve plan capacity against the actual required template count. Connected sender allowances and the EmailJS account balance require independent checks. No paid plan was chosen. Delivery acceptance must distinguish provider acceptance from observed inbox receipt. Reserve shared pacing capacity for account messages across all API instances.

Keep the requested GET /api/cron/process-notifications with exact Bearer CRON_SECRET authorization and PostgreSQL jobs/attempts. Vercel documents missed/duplicate runs, overlaps and no automatic retry on failed Cron invocations. A later staging check must observe an actual scheduled invocation. A manual call proves only endpoint behavior. [Cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs)

Daily-only mode may offer digest, weekly summary and milestone catch-up with disclosed timing tolerance. It cannot expose precise workout offsets, intraday hydration or arbitrary send times as supported. Retain DST, quiet-hour, revision, expiry, leases and unknown-send handling from Section 16. Recheck legacy Cron availability at deployment and review a migration only if required.

## Configuration modes for Phase 03 and later consumers

Mode names in this table describe the configuration contract. No runtime configuration or adapters have been implemented.

| Mode | Food and core behavior | AI | Email and scheduler |
| --- | --- | --- | --- |
| Local | Manual entry and curated fictional fixtures. Both differentiators use deterministic rules. Later persistence/security checks still require PostgreSQL and Redis. | Disabled. Use controlled adapter responses for failure tests when implemented. | Test mailbox in development/test. Explicit manual dry-run dispatcher tests, with no external sends. |
| Synthetic demo | Fictional accounts, clearly labeled fixtures and preserved unknown data. Optional food lookups use individually enabled adapters. | Off by default. Optional capped calls accept only approved fixture IDs after provider/audience checks. | Previews and dry-run metrics. Optional reminders default off. Any live inbox test requires an authorized recipient. |
| Live | Each enabled adapter validates its own required configuration. Manual features remain usable during provider outages. | Key/model plus actual quota, audience, data handling and budget resolved before enabling applicable inputs. | Verified sender, keys, templates, monthly allowance and recipient authorization. Scheduler tier and cadence determine exposed controls. |

Validate only the credentials required by enabled adapters. In Phase 03 define explicit server-side mode and adapter choices, fail closed for enabled but invalid integrations, and expose safe capability flags. Keep backend configuration separate from VITE_* public values. An unavailable dependency must yield a controlled error or explicit fallback.

## Actual checks and evidence

| Check | Result |
| --- | --- |
| Complete architecture, canonical skill, root and nested instructions | Read. Root AGENTS.md is the only repository AGENTS.md. Canonical workflow is valid for explicit reading. |
| Configuration presence extracted from Section 17 | All 26 process variables absent. Values were never printed. No .env files, package.json or vercel.json found. Presence cannot determine whether an external account exists. |
| Git status | git status --short --branch failed because this directory is not a Git repository. |
| Public documentation | Official USDA, OFF, Gemini, EmailJS and Vercel pages retrieved through web research. This verifies published documentation separately from runtime connectivity. |
| USDA direct probe | At 2026-11-16 01:46:57 Asia/Manila, GET https://api.nal.usda.gov/fdc/v1/food/171077?api_key=DEMO_KEY failed with WebException because api.nal.usda.gov could not resolve. No HTTP status, nutrients or quota headers obtained. DEMO_KEY is the published exploration credential. |
| OFF direct probe | Same second, GET https://world.openfoodfacts.net/api/v3.6/product/3274080005003.json?fields=code,product_name,nutriments,serving_size,nutrition_data_per failed with WebException because world.openfoodfacts.net could not resolve. Used the documented public staging authentication. No HTTP response obtained. |
| Probe identification | Both requests used FitTempoFeasibility/0.1 (read-only portfolio feasibility check). A real contact email remains needed for the production header. |
| Alternate retrieval | USDA web retrieval exposed JSON content-type metadata with no body/status. OFF staging web retrieval reported inaccessible. Neither counts as successful food data validation. |
| Gemini and EmailJS calls | Blocked by absent configuration, approved AI fixture/audience evidence and an authorized inbox. No external invocation or delivery evidence exists. |
| Scheduler execution | Blocked by absent deployment, plan, secret and endpoint. No real Cron run observed. |
| Mocks and application checks | No mocks executed. No application code/scripts exist, so build, typecheck and application tests are not applicable to Phase 02. |

The food worker made two bounded direct probes. The AI/email/cron worker performed read-only documentation/configuration verification. The lead owns all document changes. No recursive delegation occurred.

## Open gates and next action

| Gate | Owner phase or repair action |
| --- | --- |
| Runtime food responses and barcode miss | Restore runtime DNS/network access, rerun small USDA and OFF staging reads and record safe response fields/status. Obtain the project USDA key before live acceptance. |
| Source/attribution and conversions | Phase 10 verifies real record basis, missing fields, attribution and provider-wide limits. Avoid mapping the per-user search limit directly onto OFF's per-IP allowance. |
| AI model, quota and audience | Phase 19 requires configured access, approved synthetic fixture registry and policy gates. Public personalized uploads stay disabled until resolved. |
| Email sender/template capacity and inbox | Phase 21 requires the actual account/sender, private-key security, sufficient templates, allowance and an authorized test recipient. |
| Scheduler capability | Phases 22/23 implement capability enforcement and durable processing. Phase 26 verifies the real project/plan, deployment auth and scheduled invocation. |
| Other infrastructure | PostgreSQL, Redis and private storage remain unconfigured. Provider/account selection, pooling, backup and private-read checks remain pending in their consuming phases. |

Phase 02 remains partially blocked at its live-service gate. Phase 03 can proceed on explicit request with local/synthetic defaults and the above open items carried forward. All application scaffolding and clean-install/typecheck/build/proxy evidence belong to Phase 03. Stop here before that phase.
## Current AI provider

Groq replaces Gemini for approved synthetic food images. Check the selected model's availability, organization quotas, and data controls before any live test. The Gemini findings below describe the original feasibility review. [Groq vision](https://console.groq.com/docs/vision) · [Rate limits](https://console.groq.com/docs/rate-limits) · [Data controls](https://console.groq.com/docs/your-data)
