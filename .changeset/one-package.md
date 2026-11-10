---
"arcadekit": minor
---

The kit is one package. `arcadekit` replaces the nine `@arcadekit/*` packages (`core`, `input`, `content`, `save`, `audio`, `render-three`, `runtime`, `net`, `foldkit`), which get no further release (ADR-0018).

**Breaking:**

- Replace the `@arcadekit/*` dependencies with `arcadekit`, and change each import from `@arcadekit/<entry>` to `arcadekit/<entry>`: `@arcadekit/runtime/browser` is `arcadekit/runtime/browser`. The sixteen entries and what each exports are unchanged. The package has no root export.
- `effect` is the one required peer dependency. `three`, `@types/three`, `foldkit` and `@effect/platform-browser` are optional peers: install the ones the entries you import need.
- The Effect service keys follow the name: `@arcadekit/audio/Audio` is `arcadekit/audio/Audio`, and `@arcadekit/net/PeerConnector` is `arcadekit/net/PeerConnector`.
