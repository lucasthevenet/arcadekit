// arcadekit/net/worker: the signalling worker, for Cloudflare (#25). It introduces a
// lockstep run's peers so they can open WebRTC data channels, then gets out of the way; it never
// carries game input. An app's Worker is a few lines over `SignallingWorker`: the Durable Object
// class of one join code's room, and the Worker's `fetch`. It runs only on Cloudflare Workers: it
// imports `cloudflare:workers`, and it has no DOM. Its one module is a namespace, and it is the
// one module of the kit that runs an Effect itself, since Cloudflare owns its entry points.

export * as SignallingWorker from "./signalling-worker";
