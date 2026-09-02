---
"@verglas-org/worker-js": minor
"@cloudflare/workers-utils": minor
"@cloudflare/deploy-helpers": minor
"wrangler": minor
---

Add bounded historical catch-up controls for scheduled Verglas Workers

Cron triggers can now include an inclusive UTC `start_date` and a
`max_concurrent` limit. Deployment preserves these controls, scheduled handlers
receive the historical deadline through `scheduledTime`, and live cron runs can
continue while the historical backlog is processed.
