<p align="center">
  <img src="docs/assets/verglas-mark.png" alt="Verglas" width="112">
</p>

# Verglas SDK

This repository contains the public Verglas developer surface: the Worker CLI,
the JavaScript and Python Worker SDKs, and the product documentation. The CLI
is derived from the open-source Wrangler implementation and maintained
independently by Verglas.

## CLI

```sh
pnpm install
pnpm --dir packages/verglas run build
node packages/verglas/bin/verglas.js --help
```

The CLI targets `https://api.verglas.dev/client/v4` by default. Configure
non-interactive access with `VERGLAS_API_TOKEN` and `VERGLAS_ACCOUNT_ID`.
`VERGLAS_API_BASE_URL` overrides the endpoint.

The source trees for Create Cloudflare, Miniflare, Chrome DevTools patches,
and Pages Shared are deliberately not vendored in this repository. Published
runtime packages may still be consumed where the Wrangler-derived CLI needs
their public APIs.

See [NOTICE](NOTICE), [LICENSE-MIT](LICENSE-MIT), and
[LICENSE-APACHE](LICENSE-APACHE) for attribution and licensing.

## Worker SDKs

- [`@verglas/worker-js`](packages/worker-js) builds JavaScript and TypeScript
  Workers and Durable Objects into Verglas WebAssembly components.
- [`verglas-worker`](packages/worker-py) provides the Python Worker runtime and
  component builder.

## Documentation

The Mintlify documentation source lives in [`docs/`](docs), with navigation in
[`docs.json`](docs.json). Runtime implementation remains in
[`verglas-org/verglas`](https://github.com/verglas-org/verglas).
