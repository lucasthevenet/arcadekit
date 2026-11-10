# arcadekit

Reusable primitives for building browser games with [Effect](https://effect.website) 4, [Foldkit](https://foldkit.dev) and [Three.js](https://threejs.org): a deterministic simulation core, a game loop and engine, input, content loading, saves, audio, pixel-art rendering, lockstep multiplayer and the Foldkit bindings. The docs are at [arcadekit.dev](https://arcadekit.dev), with a page for each entry.

**Status: alpha.** Interfaces and stored data change whenever that improves the code, with no compatibility layers. Each release's [changelog](https://github.com/lucasthevenet/arcadekit/blob/main/packages/arcadekit/CHANGELOG.md) says what broke.

## Install

```bash
pnpm add arcadekit effect
```

`effect` (~4.1) is the one required peer dependency. The others are optional: install the ones the entries you import need.

| Peer | Range | Needed by |
| --- | --- | --- |
| `three` | ^0.187 | `arcadekit/render-three` |
| `@types/three` | ^0.187 | `arcadekit/render-three`, for its types (a dev dependency) |
| `foldkit` | ~0.170 | `arcadekit/foldkit` |
| `@effect/platform-browser` | ~4.1 | `arcadekit/save/browser`, and Foldkit itself |
| `@cloudflare/workers-types` | ^5 | `arcadekit/net/worker`, for the types of Cloudflare's runtime (a dev dependency) |

They are peers so your app has one copy of each: Effect services and Three.js `instanceof` checks need that.

The package is ESM only and has no root export: import an entry, such as `arcadekit/core`. It needs TypeScript 5.4 or later, and Node 22 or later for tooling. TypeScript 5.4 to 5.6 need `skipLibCheck`, since Effect 4.1's own type files need 5.7.

While below 1.0, a minor version (0.3 to 0.4) may break the interface, and its changelog says how; a patch doesn't. Use a `~` range to take only patches.

## Entries

Each entry's README has an example. An entry imports only the entries under "Uses".

| Entry | What it gives you | Uses |
| --- | --- | --- |
| [`arcadekit/core`](src/core/README.md) | `FixedStepClock`, seeded `makeRng`, struct-of-arrays pools, `SpatialGrid`, `EventBuffer`. No DOM and no Effect |  |
| [`arcadekit/input`](src/input/README.md) | `InputController`: keyboard, gamepad, touch-drag and swipes mapped to named axes and buttons. No Effect | DOM |
| [`arcadekit/content`](src/content/README.md) | `loadContent` and `makeContentLoader`: load files, validate them with an Effect Schema, cache the first success | Effect |
| [`arcadekit/content/browser`](src/content/README.md) | `fetchJsonSource` | Effect, DOM |
| [`arcadekit/save`](src/save/README.md) | `makeSaveStore`: a game's records by id under one versioned key | Effect |
| [`arcadekit/save/browser`](src/save/README.md) | `BrowserSaveStorage`: localStorage, or memory if the browser refuses | Effect, `@effect/platform-browser`, DOM |
| [`arcadekit/audio`](src/audio/README.md) | `AudioSystem`, the `Audio` service with `SilentAudioLayer`, and `makeAudioSettingsStore` | Effect |
| [`arcadekit/audio/browser`](src/audio/README.md) | `BrowserAudioLayer` (Web Audio) | Effect, DOM |
| [`arcadekit/render-three`](src/render-three/README.md) | `Stage`, `MeshInstances`, camera helpers, and pixel-art sprites: `loadSpriteSheet`, `InstancedSprites`, `PixelCamera` | Effect, Three.js, DOM |
| [`arcadekit/runtime`](src/runtime/README.md) | `GameSimulation`, the DOM-free half a game implements, and `GameLoop`, which steps one anywhere. `PlayerInputs`, the step input of a game with several players, and `soloInput` | Effect, core |
| [`arcadekit/runtime/browser`](src/runtime/README.md) | `GameDefinition`, `makeGameEngine`, `makeEngineLoader`, `combineViews` | Effect, core, DOM |
| [`arcadekit/runtime/testing`](src/runtime/README.md) | `manualFrames`: a frame source a test drives, to run an engine without a browser's frames |  |
| [`arcadekit/net`](src/net/README.md) | Lockstep multiplayer for 2 to 4 peers over a `Transport`, with an in-memory network for tests. `combinePlayerInputs` makes `PlayerInputs` from its confirmed steps. `CoopRules`, a Co-op game's lockstep parts | Effect, core, runtime |
| [`arcadekit/net/browser`](src/net/README.md) | `makeCoopClient`, the Co-op client: one player's lobby, run and drawing for a `CoopGame`, over `browserCoopRooms`. Under it, `hostRoom` and `joinRoom` (join code to WebRTC links) and `linksTransport` | Effect, core, runtime, DOM |
| [`arcadekit/net/testing`](src/net/README.md) | `fakeCoopRooms`, `manualTicker` and `testCoopGame`: a Co-op client's rooms, ticker and game for tests, with no browser | Effect, core, runtime, DOM types |
| [`arcadekit/net/signalling`](src/net/README.md) | The protocol a signalling server speaks, as Effect Schemas | Effect |
| [`arcadekit/net/worker`](src/net/worker/README.md) | The signalling worker, for Cloudflare: `signallingRoom` (a room's Durable Object class) and `signallingWorker` (the Worker's `fetch`) | Effect, Cloudflare Workers |
| [`arcadekit/foldkit`](src/foldkit/README.md) | `gameViewport`, `engineEntry`, `keyPresses`, `shortcutPresses` | Effect, Foldkit, runtime, DOM |

The source is in [the arcadekit repository](https://github.com/lucasthevenet/arcadekit), with two genre packages and two demo games built on these entries. [ADR-0018](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0018-one-package-with-entries.md) records why the kit is one package.
