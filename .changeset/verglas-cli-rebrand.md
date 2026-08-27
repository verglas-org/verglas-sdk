---
"verglas": minor
"@cloudflare/workers-utils": minor
---

Add the standalone Verglas Workers CLI.

The new `verglas` package is based on the Workers CLI implementation and uses `https://api.verglas.dev/client/v4` by default. `VERGLAS_API_BASE_URL` selects another compatible endpoint, while `CLOUDFLARE_API_BASE_URL` and its deprecated `CF_API_BASE_URL` alias remain available for compatibility.
