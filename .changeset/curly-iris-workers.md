---
"verglas": minor
"@verglas-org/worker-js": minor
---

Add independently deployable and triggerable Python notebook cells

`verglas notebooks deploy` materializes every nbformat-4 code cell as a Python Worker in one shared process group, while `verglas notebooks run` executes the ordered pending suffix or reruns one cell. Stream bindings now accept stable producer-event identities, and Python service bindings preserve object and origin metadata for Durable Object notebook sources.
