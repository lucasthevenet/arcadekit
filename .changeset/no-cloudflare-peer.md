---
"arcadekit": patch
---

`arcadekit` no longer lists `@cloudflare/workers-types` as an optional peer dependency, which none of its code uses. Nothing breaks: a Worker that hosts the relay depends on `@cloudflare/workers-types` itself, as `examples/relay-cloudflare` does.
