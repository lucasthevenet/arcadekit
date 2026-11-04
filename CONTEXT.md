# gamekit glossary

The words the packages, docs, specs and findings use. One vocabulary for the whole workspace.

**GameSimulation**: the DOM-free half of a game (`@gamekit/runtime`): how to create a run's state, advance it by one step, drain its events and sample it. A genre exports one from its root entry (`survivorsSimulation`, `pushPuzzleSimulation`). The runtime never looks inside the state.

**GameDefinition**: a game as the browser runs it (`@gamekit/runtime/browser`): its `GameSimulation` plus its `GamePresentation`, which reads input from the viewport and draws into it. A genre builds it in its `./browser` entry as `{ ...simulation, createInput, createView }`.

**GameLoop**: runs a `GameSimulation` (`@gamekit/runtime`): one run at a time, its fixed clock, its events and samples. It owns the step order and the time policy; time and input come from its caller. `GameLoop.frame` is the seam where stepping adapters plug in: the browser's `GameDriver`, tests and replays, and #25's timer or lockstep runner. The driver's `FrameSource` only times its drawing ([ADR-0010](docs/adr/0010-a-game-is-a-simulation-and-a-presentation.md)).

**Run**: one play-through, from `start` to `stop` or the next `start`. A survivors run is one attempt to survive; a push-puzzle run is one attempt at one level. Restarting starts a new run with the same config. Each run has its own state object, made by the genre's `create`, so a view can tell runs apart by identity. A genre can end its run itself (survivors' `runEnded` event, push-puzzle's `levelSolved`). The runtime keeps stepping the run until `stop` or the next `start`, and those steps do nothing.

**Step**: one fixed-length tick of the simulation (1/60 s by default), run by `GameLoop`. Steps are numbered from 0 in each run (`stepIndex`), and an input source reads each one's input by that number. A slow frame can run several steps to catch up; an input source's `endStep` runs after each one, and its `endFrame` once per frame that ran at least one step. A step must not allocate and must be deterministic: the same state and input give the same result.

**Turn**: one player action in a turn-based genre: a move or an undo in push-puzzle. A step holds at most one turn; most steps hold none. Don't use "step" for a turn or "turn" for a step.

**Frame**: one `GameLoop.frame` call: zero or more steps, then one `endFrame` (if it stepped), the event flush and the sample check. In the browser it is one animation frame (`requestAnimationFrame`), after which the view draws once. In a replay it is usually one step. Don't call a step a frame.

**Event**: a rare, meaningful fact a run reports to the outside ("level solved", "leveled up"), pushed into an `EventBuffer` during a step and drained by the runtime. Never per-entity data. An event's **payload** is the data it carries. Each genre declares its events and their payload Schemas once, in its root entry's `events.ts`, and apps use those Schemas in their Model and Messages. A **sample** is the runtime's read of the state for the UI (a HUD), also delivered as an event: every so many milliseconds on the time `GameLoop`'s caller passes in (wall-clock time in the browser), or right after the game's **version** number changes (a turn-based HUD). In both genres, the sample is a `hud` event that carries a `HudSample`. _Avoid_: snapshot for a sample.

**Snapshot**: a copy of a run's whole state that could be restored. The runtime has none (see finding 11). Don't call a sample a snapshot.

**Replay**: a deterministic re-run: the same seed and input script give the same run. Both genres' replay tests check it, running the simulation through `GameLoop` as the demos do; survivors' pins a recorded state hash and push-puzzle's a recorded end state. The push-puzzle demo's "Replay" button only starts the level again.

**Input source**: where each step's input comes from (`StepInput`): a device, a script or, for #25, a buffer of confirmed inputs. `read(step)` gives one step's input before that step. A genre's browser `InputSource` is a `StepInput` that owns resources, usually wrapping an `InputController`, and ignores the step number; a script indexes by it. A source that reads presses forgets them after each step (`endStep`), so one press reaches one step.

**View**: a genre's `GameView`, part of its `GamePresentation` (`@gamekit/runtime/browser`). It draws a run into the viewport once per browser frame, after the frame's steps, and never changes the run's state. A test or replay that steps a `GameLoop` has no view. Not Foldkit's `view` function, which draws the app's UI. _Avoid_: renderer, which is `Stage`'s `WebGLRenderer`.

**Viewport**: the DOM element the view draws a run into and the input source reads input from. The runtime calls it `element` in `attach`; the view gets it as `container` and the input source as `surface`. In a Foldkit app, `gameViewport` (`@gamekit/foldkit`) renders it, and `engineEntry` keeps the engine attached to it while it is in the document. One per document.

**Engine**: the Effect-facing API of a running game (`GameEngine`, `@gamekit/runtime/browser`): attach to an element, listen to events, start, modify, pause, stop. Each genre declares its own engine service.

**Content source**: where content files come from (`ContentSource`), such as `memorySource` in tests or `fetchJsonSource` in the browser. A genre's **content definition** (`ContentDefinition`) is its schema, the file each part comes from, and the checks the schema can't express, as one value. A genre's content service, built with `makeContentLoader` from the definition and a source, loads and checks the files once per app; a failed load isn't kept, so it can be retried. Tests load the same definition with `loadContent`, so they run the same checks.

**Pool**: a fixed-capacity set of entities stored as one typed array per field (`createPool` in `@gamekit/core`). Removing swaps the last entity in, so pool indices are not stable. An **identified pool** (`createIdentifiedPool`) also gives each entity a stable id, for a genre that must name one entity across removals (undo, tweening).

**SpatialGrid**: a uniform grid in `@gamekit/core` for "which points are near here?", rebuilt every step from continuous positions. Not a tile map.

**Tile map**: a genre's grid of static cells (wall, floor, hole), stored in typed arrays and indexed by column and row (`row * cols + col`). It describes the level, not where entities are. Push-puzzle's lives in the genre package.

**Mesh instances**: copies of one mesh drawn in a single draw call (`MeshInstances` in `@gamekit/render-three`), for anything a view draws many times: enemies, gems, floor tiles. Each instance gets a position, a uniform scale, a rotation around the vertical axis and a color. Not a pool: mesh instances belong to the view and hold only what it draws. The view sets them from the state it reads.

**Save**: what a demo app keeps between sessions: records by level or hero id, such as a level's best move count or a hero's best time. It is UI state, not simulation state, so no genre package knows about it. Each app reads it once at startup and writes it on the genre's end-of-run event (survivors' `runEnded`, push-puzzle's `levelSolved`), never per frame and never from a step. It lives in localStorage under one versioned key per game (`gamekit/<game>/save`). A write re-reads the stored save and keeps the best of both. A save that fails to decode (corrupt, or an unknown version) is copied to `<key>/corrupt` and read as empty. `@gamekit/save` (`makeSaveStore`) does all of that; each app passes its key, the stored field name, its record Schema and its **record merge** (how two records for one id become one), and wraps the result in its own Save service. See [ADR-0009](docs/adr/0009-a-save-package-is-earned.md). _Avoid_: snapshot, which is a whole run's state.

**Kit**: the shared packages `core`, `input`, `content`, `save`, `render-three`, `runtime` and `foldkit`. Genre packages and demo apps build on it. A **primitive** is one of the kit's building blocks, such as `createPool` or `InputController`.

**Genre package**: a package that implements one kind of game on the kit (`@gamekit/survivors`, `@gamekit/push-puzzle`). Its root entry holds the content schema, the content service, the simulation and its `GameSimulation`, and the event payload Schemas, with no DOM or Three.js (its `tsconfig.root.json` checks it with no DOM types; keeping Three.js out is a convention); its `./browser` entry holds the input source, the view, the `GameDefinition` and the engine.

**Finding**: a place where a genre had to change, work around, copy or bypass a shared primitive, or where a shared primitive's name or docs assume one genre. A primitive a genre simply doesn't use is not a finding. See `docs/push-puzzle-findings.md`.

Message, Command, Subscription, Mount and `resources` are Foldkit's words, used in the apps. An app turns events into Messages, so a Message is not an event.
