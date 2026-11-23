---
"arcadekit": minor
---

`Relay.join` takes the name the host proved the asking peer holds, and refuses a peer whose address asks for another with `"not your name"`. A host can no longer let a peer in without saying who may use a name: it passes the name its own check of the request established, or `Relay.anyone` to let anyone take any free name.

**Breaking**

- `Relay.join(url, present, options)` is `Relay.join(url, proven, present, options)`: `Relay.join(request.url, playerOf(request), present)`, or `Relay.join(request.url, Relay.anyone, present)` for a relay that proves nothing.
- `relay.connect(url, send)` is `relay.connect(url, proven, send)`.
- `Relay.Refused["reason"]` has one more case, `"not your name"`.
