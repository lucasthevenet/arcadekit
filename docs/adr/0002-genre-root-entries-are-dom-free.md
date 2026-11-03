---
status: accepted
---

# A genre's root entry has no DOM or Three.js

A genre's simulation must run where there is no DOM: in a Web Worker, on a game server, in a test. So a genre package's root entry (content schema, content service, simulation) uses no DOM and no Three.js, and only its `./browser` entry (the `GameDefinition`, view, input and engine) may use them. `@gamekit/content` follows the same rule: `fetchJsonSource` needs `fetch`, so it lives in `@gamekit/content/browser` (#20, finding 6).

## Consequences

- `content`, `survivors` and `push-puzzle` each have a `tsconfig.root.json` that typechecks the root entry with no DOM types, and `pnpm typecheck` runs it. A `document` or `fetch` in a root entry fails the check. `core` has no DOM types anywhere. Before #20 the rule was a convention: survivors' tsconfig gave the whole package DOM types.
- The check misses a Three.js import that uses no DOM type, such as `Vector3`, because `skipLibCheck` hides the DOM names inside Three.js's own types. Keeping Three.js out is a convention.
- #24: sound and asset loading (Web Audio, `fetch`, Three.js loaders) go in `./browser` entries or in browser-only packages. A root entry can still hold the ids that name a sound or a model, since those are plain content.
- #25: stepping a run in a Worker or on a server needs only the root entry. The runtime's `GameDriver` is browser code today: it loops on `requestAnimationFrame` and attaches to an element.
- #26: published packages keep their `./browser` exports, and root entries stay checked with no DOM types.
