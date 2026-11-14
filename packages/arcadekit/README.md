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
| [`arcadekit/core`](src/core/README.md) | Namespaces in Effect's shape: `FixedStepClock`, the seeded `Rng` (with `pickDistinct`), `EntityPool` (struct-of-arrays entities, identified or not), `SpatialGrid`, `EventBuffer`. Rings of records a step pushes to and a view reads: `Ring`, `RingReader`. A level's static cells with neighbours and a flood fill: `TileMap`. What their records hold: `Layout`. The state hash: `StateHash`. The exact math a step calls: `ExactMath` (`hypot2`, `sin`, `cos`, `powInt`, `clamp`, `lerp`, `hashCell`) and `Point2` (`clampLength`, `moveToward`). Timers (`Timer`) and tweens (`Tween`) as plain functions. No DOM; Effect for its module shape only | Effect |
| [`arcadekit/input`](src/input/README.md) | `InputController`, a namespace in Effect's shape: keyboard, gamepad, touch-drag and swipes read as a game's named axes and buttons, with `InputController.moveAxes`. Its reads are plain | Effect, DOM |
| [`arcadekit/content`](src/content/README.md) | `Content` and `Asset`: a game's content files, validated with an Effect Schema, and what the app loads once for it, such as a sprite sheet. Each is a class that keys its own service and keeps the first success. `ContentSource`, where a content's files come from, with the `ContentError` they fail with | Effect |
| [`arcadekit/content/browser`](src/content/README.md) | `FetchContentSource`: a content source that fetches a game's files over HTTP (`FetchContentSource.fromUrl`) | Effect, DOM |
| [`arcadekit/save`](src/save/README.md) | `Save`, a game's records by id under one versioned key, and `Setting`, one value kept apart from it, such as the audio settings. What their services give: `Stored`, a namespace in Effect's shape | Effect |
| [`arcadekit/save/browser`](src/save/README.md) | `BrowserSaveStorage`: localStorage, or memory if the browser refuses (`BrowserSaveStorage.layer`) | Effect, `@effect/platform-browser`, DOM |
| [`arcadekit/audio`](src/audio/README.md) | `AudioSystem`, what a game plays through and the key of its service, with `layerSilent`; `AudioMixer`, the mixer behind the browser's; `CueTable` for a genre's cues; and `AudioSettings`, the audio settings' Schema and default. Namespaces in Effect's shape | Effect |
| [`arcadekit/audio/browser`](src/audio/README.md) | `BrowserAudioSystem.layer` (Web Audio), a namespace in Effect's shape | Effect, DOM |
| [`arcadekit/render-three`](src/render-three/README.md) | `Stage`, `MeshInstances` (a matrix, a color and declared attributes for each instance), `Camera` (a 3D stage's camera over the ground), and pixel-art sprites: `SpriteSheet` (`fromUrl`, `resolveTags`, `frameAt`), `InstancedSprites` (batches that grow), `TileLayer` (the cells on screen), `Gait`, `PixelCamera` (with `groundOnScreen`) | Effect, Three.js, DOM |
| [`arcadekit/render-three/testing`](src/render-three/README.md) | `TestSpriteSheet`, `DrawnSprites` and `Png`: a sheet with no image, what a batch or a tile layer shows, and two checks of a sheet's PNG, for a view's tests, with no WebGL | Effect, Three.js, DOM types, Node (`node:zlib`) |
| [`arcadekit/game`](src/game/README.md) | A game's declarations: `Game.Event`, `Game.Command`, `Game.Rejection` and `Game.Simulation` (the DOM-free rules), and `Game.makeLoop`, the loop that steps one anywhere. `Game.PlayerInputs`, the step input of a simulation several players can play, and `Game.soloInput` | Effect, core |
| [`arcadekit/game/browser`](src/game/README.md) | The same, plus `Game.Engine`: a simulation with the view and input that draw it and read its input, as a service an app drives. `Game.Frames`, `Game.frameLoop`, `Game.combineViews` | Effect, core, DOM |
| [`arcadekit/game/scenario`](src/game/README.md) | Scenarios: given a run, after these steps and commands, it reported these events. Checks a simulation in a test, with no browser | Effect, core |
| [`arcadekit/game/testing`](src/game/README.md) | `ManualFrames`: a frame source a test drives, to run an engine without a browser's frames |  |
| [`arcadekit/net`](src/net/README.md) | Lockstep multiplayer for 2 to 4 peers over a `Transport`, with an in-memory network for tests: a session steps a declared simulation whose step input is a `Game.PlayerInputs`, and carries a player's commands to every peer at one step | Effect, core, game |
| [`arcadekit/net/browser`](src/net/README.md) | `Coop`, a game's engine declared for several players: its class is the key of the Co-op client, one player's lobby, run and drawing, over the app's `CoopRooms` (`CoopRooms.layer`), heard as `CoopEvent`s. Under it, `SignallingRoom` (join code to WebRTC links, made by a `PeerConnector`) and `RtcTransport` | Effect, core, game, DOM |
| [`arcadekit/net/testing`](src/net/README.md) | `FakeCoopRooms`, `ManualTicker`, `PageTimers` and a test game (`TestGame`): the rooms, the ticker, the Clock and scheduler of a test on fake timers, and a game for a `Coop`'s tests, with no browser | Effect, core, game, DOM types |
| [`arcadekit/net/signalling`](src/net/README.md) | The protocol a signalling server speaks, as Effect Schemas | Effect |
| [`arcadekit/net/worker`](src/net/worker/README.md) | The signalling worker, for Cloudflare: `SignallingWorker.room` (a room's Durable Object class) and `SignallingWorker.make` (the Worker's `fetch`) | Effect, Cloudflare Workers |
| [`arcadekit/foldkit`](src/foldkit/README.md) | `Viewport`, `EngineEntry`, `KeyPresses`, `ShortcutPresses`, each a namespace in Effect's shape | Effect, Foldkit, game, DOM |

The source is in [the arcadekit repository](https://github.com/lucasthevenet/arcadekit), with two genre packages and two demo games built on these entries.
