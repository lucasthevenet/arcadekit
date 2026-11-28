# @arcadekit/three

## 0.1.0

### Minor Changes

- [#373](https://github.com/lucasthevenet/arcadekit/pull/373) [`99feb2d`](https://github.com/lucasthevenet/arcadekit/commit/99feb2d1762692209abba062ad87ee4defa8362f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A component can require others. `Component.define` and `Component.tag` take `requires`, and a spawn or an add fills in each required component the entity lacks, bare or with the value written there. `Commands.spawns` names what is filled in, so the order of systems sees it, and `RequiredOf` reads it in the type.

  **Breaking**

  - `Three.instances` and `Three.objects` refuse a kind whose `of` doesn't require the `Position` of its `transform`. An entity spawned without one was never drawn, and nothing said so. Before, `Component.tag("game/Rock")`; now, `Component.tag("game/Rock", { requires: [Transform3d.Position] })`.
  - A replay recorded before a component required something spawns it without, and drifts from a game that fills it in. Record it again once the component requires others.
  - `ComponentDef` takes a fourth type parameter and `ComponentValue` a third, the names a component requires. A `ComponentDef<S, St, N>` written out by hand reads as requiring any name, which `Commands.spawns` leaves out of the order check: write `ComponentDef<S, St, N, never>` for one that requires nothing.

- [#464](https://github.com/lucasthevenet/arcadekit/pull/464) [`6fcd621`](https://github.com/lucasthevenet/arcadekit/commit/6fcd621808abdc01b33b5ebb63f01497b283fef1) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A flat game draws with `Three` alone. `Three.camera2d(name, { height, follow, within, smooth, snap })` is a frame-stage system that views the game's plane through an orthographic camera whose unit is the game's, fitted to the canvas's shape each frame and held inside a level's bounds. With `smooth`, it follows its entity through `Transform2d.smooth`, the store a kind drawn with `smooth` draws from, so the two agree; its camera is a `System.local`, each app its own. `Three.toPlane(point)` returns the place of the plane under a point of the canvas, such as the pointer, through the camera the scene was last drawn with, for an input-stage system to put in an action. `Three.sprite(texture, { width, height })` makes the look of a picture on a quad. `Three.Scene` holds the canvas's `size`, which `Three.plugin` reads at the start of each frame from `Three.Renderer`'s new optional `size`, and `Three.makeRecorder(canvas)` stands for a canvas of a given size. The modules `@arcadekit/three/Camera` and `@arcadekit/three/Sprite` give the same exports.

  **Breaking**

  - `Gltf.instances(name, { from, look, … })` is now `Three.instancesFrom(name, { from, look, … })`, and `Gltf.objects(name, { from, make, … })` is now `Three.objectsFrom(name, { from, make, … })`. The options are the same. A game whose bundles hold textures alone no longer imports `Gltf`, nor Three.js's glTF loader with it. `Gltf` keeps `model` and `mesh`.
  - Their option types `Gltf.InstancesOptions` and `Gltf.ObjectsOptions` are now `Three.InstancesFromOptions` and `Three.ObjectsFromOptions`.
  - `Three.SceneShape` has a `size` field. Code that builds a `SceneShape` of its own gives it one, such as `size: { width: 0, height: 0 }`.

- [#381](https://github.com/lucasthevenet/arcadekit/pull/381) [`1288c30`](https://github.com/lucasthevenet/arcadekit/commit/1288c30e4e95dbf10f4de72aa9e4c9ff79dfa503) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Three.instances` and `Three.objects` type `transform` as `Three.TransformOf<O>` of the kind's `of`: the module whose `Position` `of` requires, whichever component of its type it is. A helper that took `of` and `transform` as two unions compiled a call that paired a 3D marker with `Transform2d`, and its entities, spawned with the marker alone, were never drawn, with no error. The same helper, written with `TransformOf`, refuses such a call.

  **Breaking**

  - `Three.Drawn` is removed. Its check is `Three.TransformOf`, and a mismatched kind's error is now on `transform`, not on `of`.
  - A helper that types `of` and `transform` as two unions no longer compiles. It takes `of` as a type parameter, and `transform` as `TransformOf` of it:

  ```ts
  const crowd = <const O extends Three.Which["of"]>(
    name: string,
    of: O,
    transform: Three.TransformOf<O>
  ) => Three.instances(name, { of, transform, geometry, material });

  crowd("game/Rocks", Rock, Transform3d);
  crowd("game/Lifted", Rock, Transform2d); // doesn't compile
  ```

  - The type parameter `T` of the transform is gone from both functions' signatures.

- [#300](https://github.com/lucasthevenet/arcadekit/pull/300) [`e5c0e4b`](https://github.com/lucasthevenet/arcadekit/commit/e5c0e4bd350c7ed5e3708d98fc2931bf9057bd49) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A kind of `Three.instances` or `Three.objects` names the transform it draws from, `transform: Transform3d` or `transform: Transform2d`, and reads nothing of the other. An entity with both a `Transform3d.Position` and a `Transform2d.Position` used to be drawn from the 3D one, its `Transform2d` rotation and scale left unread, with no error. It is now drawn by a kind of each, each from its own.

  **Breaking**

  - `transform` is required, and a kind without it doesn't compile. A kind of a 3D game adds `transform: Transform3d`, and one of a flat game `transform: Transform2d`.
  - A kind draws only the entities its transform places. A kind that drew flat and 3D entities together is now two kinds, one of each:

  ```ts
  const Rocks = Three.instances("game/Rocks", {
    of: Rock,
    transform: Transform3d,
    geometry,
    material,
  });
  const FlatRocks = Three.instances("game/FlatRocks", {
    of: Rock,
    transform: Transform2d,
    geometry,
    material,
  });
  ```

- [#398](https://github.com/lucasthevenet/arcadekit/pull/398) [`212d0b7`](https://github.com/lucasthevenet/arcadekit/commit/212d0b78761f928307da902f594d5ca4f2e4328e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The check that a kind's `of` gives its entities the `Position` of its `transform` counts a component that is that `Position`, not only one that requires it. A kind of `of: Transform3d.Position`, or of `[Heavy, Transform3d.Position]`, now compiles. And it refuses an `of` typed as a plain `ComponentDef` or `readonly ComponentDef[]`, whose requirements the compiler only knows as `string`. Such a kind compiled with no check, and an entity spawned with that component alone was never drawn, with no error.

  **Breaking**

  - A kind or a helper whose `of` is typed as `ComponentDef` no longer compiles. Type it as the component it is, as `typeof Rock`, or take it as a type parameter with `Three.TransformOf`:

  ```ts
  const crowd = <const O extends Three.Which["of"]>(
    name: string,
    of: O,
    transform: Three.TransformOf<O>
  ) => Three.instances(name, { of, transform, geometry, material });
  ```

- [#402](https://github.com/lucasthevenet/arcadekit/pull/402) [`df2bbed`](https://github.com/lucasthevenet/arcadekit/commit/df2bbed95d75120fb4e300671b1d067203aae7b8) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A kind whose look or objects are built from a bundle is made with `Gltf.instances` or `Gltf.objects`, and `Three.instances` and `Three.objects` take only a look that already exists. Each function has one signature. An `of` that requires neither `Position` now fails with the whole reason as the error of the call, for `Transform3d` and `Transform2d` alike. Before, the compiler reported "No overload matches this call", cut the reason short, and ended on a mismatch between the two transform modules.

  **Breaking**

  - `Three.instances(name, { from, look, … })` is now `Gltf.instances(name, { from, look, … })`, and `Three.objects(name, { from, make, … })` is now `Gltf.objects(name, { from, make, … })`. The options are the same, and the bundle may hold any assets, textures included. Import `Gltf` from `@arcadekit/three` or `@arcadekit/three/Gltf`.
  - Their option types `Three.InstancesFromOptions` and `Three.ObjectsFromOptions` are now `Gltf.InstancesOptions` and `Gltf.ObjectsOptions`. `Three.InstancesOptions` and `Three.ObjectsOptions` remain the options of `Three.instances` and `Three.objects`.
  - `Three.Which` no longer has `transform`. Each function still takes `transform`, typed as `Three.TransformOf` of its `of`. Code that read `Three.Which["transform"]` writes `typeof Transform3d | typeof Transform2d`.
  - `Three.TransformOf<O>` for an `of` that requires neither `Position` is now `{ readonly Position: { readonly name: <reason> } }`, without the two transform modules in it.

- [#329](https://github.com/lucasthevenet/arcadekit/pull/329) [`123149a`](https://github.com/lucasthevenet/arcadekit/commit/123149a098d32801d4f899903187e73c07791aa0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Three.instances` with `color: Color.Rgb` fails the frame for a channel in `Color.Srgb` that is NaN, as it does for one below 0 or over 1. NaN, an infinity, and a number so large it wrapped past 32 bits used to be drawn as some other colour, NaN as black, with no error. A colour in `Color.Linear` is still passed through as it is.

  **Breaking**

  - A game whose colour in `Color.Srgb` holds NaN or an infinity, such as a division by zero leaves, now fails the frame with an error that names the entity, where it drew black. Give it a number from 0 to 1.

- [#349](https://github.com/lucasthevenet/arcadekit/pull/349) [`7189891`](https://github.com/lucasthevenet/arcadekit/commit/71898916cc94201bceb0a39d49ebe87fa923c297) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Three.instances` with `color: Color.Rgb` draws a channel in `Color.Srgb` below 0 as 0 and one over 1 as 1, as CSS clamps an sRGB colour, where it failed the frame. NaN and an infinity still fail the frame with an error that names the entity. A channel from 0 to 1, and any colour in `Color.Linear`, is drawn as before. Nothing breaks: a game that drew before draws the same.

- [#397](https://github.com/lucasthevenet/arcadekit/pull/397) [`e3c1733`](https://github.com/lucasthevenet/arcadekit/commit/e3c17338259952b7e689d6f39eaee4109f2bb6ca) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The packages are built by the TypeScript compiler, one file of `dist/` for each source file, and nothing is bundled. A module that an entry gathers is that module. `import { Transform3d } from "arcadekit"` is the module `arcadekit/Transform3d`, at run time and in its type, so it can be passed as `transform` to `Three.instances` and `Three.objects`. The same holds for each module of `arcadekit`, `arcadekit/net`, `arcadekit/browser` and `@arcadekit/three`.

  What breaks:

  - Each module no longer exports a copy of its own namespace, such as `Transform3d_exports` in JavaScript and `Transform3d_d_exports` in its declarations. A game that named one names the module instead.
  - The built files of `arcadekit/ecs`, `arcadekit/net` and `arcadekit/browser` are `dist/ecs/index.js`, `dist/net/index.js` and `dist/browser/index.js`. A game that imports the entries by name is not affected.

- [#460](https://github.com/lucasthevenet/arcadekit/pull/460) [`d124b09`](https://github.com/lucasthevenet/arcadekit/commit/d124b097a0d0f04ffc478d1fecc10281be64e76a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A frame system of the game's own draws an entity between its last two ticks with `Transform2d.smooth` or `Transform3d.smooth`, where it had to keep a previous position in the world. `const smooth = yield* Transform2d.smooth` hands out `smooth.position(entity, position, snap)`, `smooth.rotation(entity, rotation)` and `smooth.scale(entity, scale)`, each `Frame.alpha` of the way from where the entity was a tick ago. An entity that moved farther than `snap` in a tick, such as one that was teleported, is drawn where it is. `smooth.positions`, `smooth.rotations` and `smooth.scales` blend a run of rows that `eachChunk` hands out, with no allocation per entity, and `Color.smooth` blends a `Color.Rgb` the same way. Only a frame system can yield one, since each requires `Frame`. The app records an entity's values when a frame first reads it, outside the world, so a game that draws nothing smoothly keeps nothing, and the hash, log and save are the same with it or without.

  `Three.instances` and `Three.objects` with `smooth: true` read the same store, so a camera that follows an entity with `Transform3d.smooth` stays on the instance or the object that draws it.

  Nothing breaks. One thing a game sees differently: an entity is drawn from where it was whenever any system drew it smoothly in the previous frame, where it was drawn where it is after a frame in which its own system didn't run.

- [#228](https://github.com/lucasthevenet/arcadekit/pull/228) [`9ff1ad3`](https://github.com/lucasthevenet/arcadekit/commit/9ff1ad312300b9f07503b45ba219e8093e4d7336) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game lists no components and no events. Defining one is enough: a load finds each component, singleton, state and event a save or a snapshot holds by its name, among the definitions the program has. So a save of a game that forgot to list one can no longer be refused, and a plugin that adds a component can no longer break the loading of every game that uses it. A save that holds a name the program no longer defines is refused with `"unknown component"` or `"unknown event"`, and the message says a migration renames or removes it. Two definitions with one name in one world are refused, as before.

  A state moves, its first tick's enter hooks and the transitions asked for included, once a hook waits for it or the world holds it: once a value has been asked for with `set`, or a save brought it. A look at a state, from any stage, changes nothing, so a frame system that reads a state no longer makes a game differ from its replay.

  **Breaking**

  - The `components` and `events` options of `App.make`, `App.load` and `Plugin.make` are gone, and so are `Plugin.components` and `Plugin.events`. Delete the lists.
  - `Transform2d.plugin` and `Transform3d.plugin` are gone, since all they did was list the components. `Three.plugin` no longer includes them.
  - `EcsWorld.load(bytes, components)` takes its components only as the ones to prefer over the program's latest definitions, for a tool that reads a snapshot with an older build's. Leave them out otherwise.
  - A state that no hook waits for is no longer entered on the first tick of every game: it is entered on the tick after a value is first asked for. A game's hash differs from before until then.
  - `EcsWorld.holds(singleton)` is new: whether the world holds a singleton as its own, written or loaded.

- [#228](https://github.com/lucasthevenet/arcadekit/pull/228) [`7e12366`](https://github.com/lucasthevenet/arcadekit/commit/7e123664fc31520ed50fa5f4227db40165b9da8a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Three.instances` with a `color` draws an entity of its kind that has no colour in the material's own colour, as if its colour were white. It used to leave that entity out with no error, so giving some entities a colour hid the others.

  **Breaking**

  - An entity without the colour component is now drawn. A game that left the colour off to hide an entity puts it in `without` instead.

- [#384](https://github.com/lucasthevenet/arcadekit/pull/384) [`96a5f7e`](https://github.com/lucasthevenet/arcadekit/commit/96a5f7eed461a30bb8e1b0950bc932471eb48d35) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The types that public signatures name are documented, and on the reference, where they were exported and marked `@internal`: `App.Systems`, `App.Handlers`, `App.Plugins`, `App.TickError`, `App.AllHandlers` and `App.External`; `Plugin.Clashes`; and `System.TickGated`, `System.TickBody`, `System.FrameOk`, `System.FrameBody`, `System.TickEffect`, `System.LayerGated`, `System.Listing` and `System.Ordered`. `@arcadekit/three/Three` adds `Three.Entries`, the assets of a bundle a look is built `from`, and `Three.Needs`, what its drawing systems require, which `Three.instances` and `Three.objects` named and a game could not.

  Nothing breaks: no export is removed or changed.

- [#164](https://github.com/lucasthevenet/arcadekit/pull/164) [`d45e1a7`](https://github.com/lucasthevenet/arcadekit/commit/d45e1a7d264c7a901568ea6f73fbf1adc08bd32a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - No export takes or returns `any`. What stands for any component, singleton, event, state, system, plugin, action or handler says what it is: `ComponentDef`, `SingletonSpec`, `EventDef<unknown>`, `State<string>`, `System<unknown, unknown>`, `Plugin.Any` (of `unknown`s), and the new `Action.AnyActionDef` and `Action.AnyHandler`, whose payload is `never`. `System.GenError` and `System.GenServices` are new: what a generator's effects fail with and need, as `Effect.gen` says it, which `System.make`, `Sound.music` and `View.publish` now return. `Driver.interval` beats on Effect's `Clock`, so a `TestClock` moves it on. The default `Assets.Loader` asks through Effect's `HttpClient`, over `fetch`.

  **Breaking**

  - `Migrate.mapField`'s `map` names the type of the old value: `(hp: number) => hp / 2`, where `(hp) => hp / 2` took it as `any`.
  - A list typed as `Plugin.AnySystem[]` or `Plugin.AnyHandler[]` and given to `App.make` makes the app need `unknown`, where `any` let it run. Type the list with what its systems need, `System.System<never, World | Time>[]`, or pass the systems themselves.
  - `ComponentDef.of`, `EventHandle.emit`, `StateHandle.is` and `StateHandle.set` are typed as methods, so that a component, an event or a state of any type is one of the types above. They work as before; a game that lints with `typescript/unbound-method` is told about one taken off its object.
  - `Sound.cues`, `Three.instances` and `Three.objects` are overloaded functions, with the same two signatures each.
  - `Three.ColorComponent`'s `r`, `g` and `b` are `FieldDef<number, unknown>`.
  - The default `Assets.Loader` resolves a path against the page's `location`, not its `<base href>`, and a file the server refused says `The server answered 404`, without the status text.

- [#455](https://github.com/lucasthevenet/arcadekit/pull/455) [`bb47fbd`](https://github.com/lucasthevenet/arcadekit/commit/bb47fbd1a1d9d224cc93013ef41426f5c2914c7c) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Every module names its types and errors by one rule. A module's main type is its name, and every other type is named for what it is after the namespace, which it does not repeat. A service's interface is the service's name and `Shape`. An error's class is named for what went wrong, and its tag is its module and its class together, so `Effect.catchTag` never takes two errors of one bare tag for one. A codec's `decode` fails with a tagged error of its module that has a `problem`, and its `encode` fails the same way and does not throw. The Oxlint rule `arcadekit/names` holds the names and the tags.

  **Breaking**

  Types:

  - `Event.EventDef` is `Event.Event`, `Event.EventReader` is `Event.Reader`, and `Event.EventHandle` is `Event.Emitter`.
  - `Action.ActionDef` is `Action.Action`, and `Action.AnyActionDef` is `Action.Any`.
  - `State.StateView` is `State.Reader`, and `State.StateHandle` is `State.Setter`.
  - `ComponentDef` and `RelationDef` of `arcadekit` are `Component.Component` and `Component.Relation`. `arcadekit/ecs` keeps `ComponentDef` and `RelationDef`.
  - The interface of `Input.Source` is `Input.SourceShape`, and that of `Sound.Output` is `Sound.OutputShape`.
  - `Sound.Line` is `Sound.Binding`, `Sound.Options` is `Sound.PlayOptions`, and `Sound.Scored`, what a recorder notes of a channel, is `Sound.Told`.
  - `Driver.Ready` is `Driver.ReadyOptions`, `Three.Which` is `Three.KindOptions`, `Audio.AudioLike` is `Audio.ContextLike`, and `Transport.WireTransport` is `Transport.OverWire`.

  Errors, with the tag `Effect.catchTag` takes:

  - `Save.SaveRefused` is `Save.Refused`, still `"SaveRefused"`. `Save.LoadRefused` is `"SaveLoadRefused"`, and its `problem` is never `"world not empty"` or `"cannot be saved"`: a migration that leaves a value that can't be saved is `"migration failed"`.
  - `Action.UnknownAction` is `Action.Unknown`, `"ActionUnknown"`, and `Action.InvalidPayload` is `"ActionInvalidPayload"`. A refused entry of an app's log says these tags.
  - `Assets.AssetFailed` is `Assets.Failed`, `"AssetsFailed"`, and `Event.InvalidEvent` is `Event.Invalid`, `"EventInvalid"`.
  - `Drift.Drifted` is `"DriftDrifted"`, `Drift.Unlike` is `"DriftUnlike"`, `Session.RewindDiverged` is `"SessionRewindDiverged"`, `Journal.HashMismatch` is `"JournalHashMismatch"`, `Journal.ReplayDiverged` is `"JournalReplayDiverged"`, and `App.FrameChangedWorld` is `"AppFrameChangedWorld"`.

  Codecs:

  - `Journal.encode` returns an `Exit` and fails with `Journal.Invalid`, `"no JSON form"`, where it threw: `yield* Journal.encode(recording)`. `Journal.decode` fails with `Journal.Invalid`, `"not a recording"` or `"older format"`, where it failed with a `Schema.SchemaError`.
  - `Message.encode` returns an `Exit` and fails with `Message.Invalid`, `"not a message"`, where it threw. `Message.decode` and `Message.decodeNotice` fail with `Message.Invalid` where they failed with a `Schema.SchemaError`.

- [#459](https://github.com/lucasthevenet/arcadekit/pull/459) [`49fab38`](https://github.com/lucasthevenet/arcadekit/commit/49fab38a9648635ed2383087de8d9bc01149a436) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Every service a program provides from outside an app has one shape: its key is the entry it is imported from and its name, `X.layer(implementation)` provides it, and its module makes the stand-in a test provides in its place. A new module, `arcadekit/Test`, makes a game's app with those stand-ins and hands them back beside it:

  ```ts
  Effect.gen(function* () {
    const game = yield* Test.make(Rogue, {
      seed: 7,
      files: { "/one.json": level },
    });
    game.input.press("KeyW");
    yield* game.step(); // the input stage, one tick, the frame stage
    yield* game.rest(); // steps until the app is settled
    game.sound.played;
    game.ui.get(Hud);
  });
  ```

  `Driver.layer(display)`, `Assets.layer(loader)` with `Assets.makeMemory(files)`, and `Three.layer(renderer)` with `Three.makeRecorder()` are new. The entries' tests of both packages hold every service to the shape.

  **Breaking**

  - `Assets.layerMemory(files)` is `Assets.layer(Assets.makeMemory(files))`.
  - `View.layer(game, mount)` is `View.mount(game, mount)`: it provides nothing a system asks for.
  - A hub has no `layer`: `hub.layer(peer)` is `Transport.layer(hub.port(peer))`.
  - A renderer made by hand is `Three.layer({ render(scene, camera) {} })`, where it was `Layer.succeed(Three.Renderer, ...)`, and a test records what is drawn with `Three.makeRecorder()`.
  - The keys of the services are their entries and names, so a service of a game's own never takes one: `"arcadekit/World"` is `"arcadekit/Services.World"`, and so for `Sim`, `Time`, `Frame`, `Commands`, `Events` and `Random`; `"arcadekit/Actions"` is `"arcadekit/Action.Actions"`, `"arcadekit/Display"` is `"arcadekit/Driver.Display"`, `"arcadekit/Transport"` is `"arcadekit/net/Transport.Transport"`, and `"arcadekit/three/Scene"` and `"arcadekit/three/Renderer"` are `"@arcadekit/three/Scene.Scene"` and `"@arcadekit/three/Renderer.Renderer"`.

- [#454](https://github.com/lucasthevenet/arcadekit/pull/454) [`054a34c`](https://github.com/lucasthevenet/arcadekit/commit/054a34c34e2ad3273f35ed15e9aa5feadc5ee56f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A module gives what a game uses and nothing else. What its own code needs is in `src/internal/`, so `State.`, `Save.`, `System.` and the rest offer only their public names, and what a system yields has no member a game must not call. The Oxlint rule `arcadekit/no-unused-internal` refuses an `@internal` export, or an `@internal` member of a public export, in the file of an entry. `arcadekit` gives the world's two types, `ReadingWorld` and `WritingWorld`, with the rest of `Services`, and a `Component` module of its own, `arcadekit/Component`, with `define`, `relation` and `tag`.

  **Breaking**

  - `State.defined`, `State.Registry`, `State.registryOf`, `State.handleOf`, `State.pending`, `State.enter`, `State.despawnScoped`, `State.refuseRemovedScopes` and `State.prepare` are gone from `State`, and so is a state's `scopes`. `State.scoped(state, value)` gives a value's tag.
  - `Save.taking`, `Save.take`, `Save.versionOf`, `Save.into`, `Save.singleton`, `Save.VisitsData` and `Save.Visits`, `System.raw`, `System.triggered`, `System.spanLevel`, `System.unique` and `System.order`, `Action.said`, `Action.QueuedAction`, `Action.jsonOf` and `Action.Intake`, `Assets.fetching` and `Assets.fetchingFrom`, `Event.Emitted` and `Event.EventBus`, `Journal.Since` and `Journal.Log`, `Plugin.flatten`, `View.Intake`, and `Peer.Options`, `Peer.PeerApp` and `Peer.build` are gone. None of them was for a game.
  - `Sound.PlayerShape` has no `_begin` and no `_flush`, and `Three.SceneShape` no `_kept` and no `_owned`. `Sound.plugin` and `Three.plugin` keep them to themselves.
  - `import { EcsWorld, CommandBuffer, SnapshotError, readSnapshot, writeSnapshot } from "arcadekit"` is gone. A program of the storage core imports them from `arcadekit/ecs`: `import { World, CommandBuffer, SnapshotError, readSnapshot, writeSnapshot } from "arcadekit/ecs"`. The storage core's types stay in `arcadekit`.
  - `Component` of `arcadekit` is the module `arcadekit/Component`, which has no `singleton`. A game defines a singleton with `Singleton.define(name, schema, initial)`. `Component.singleton` stays in `arcadekit/ecs`.
  - `Browser.sound`, `Browser.stream`, `Browser.layerSound`, `Browser.AudioLike` and `Browser.MediaLike` are gone: they are `Audio.sound`, `Audio.stream`, `Audio.layerSound`, `Audio.AudioLike` and `Audio.MediaLike`, of `import { Audio } from "arcadekit/browser"`.

- [#228](https://github.com/lucasthevenet/arcadekit/pull/228) [`44f02e9`](https://github.com/lucasthevenet/arcadekit/commit/44f02e94ac01f9f7d37a6357d43bc953c9b08cf6) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A query only reads its terms, unless `Query.writes` names the ones it writes: `Query.all(Position, Velocity).pipe(Query.writes(Position))`. The compiler refuses an assignment to a term the query doesn't name, through `each` or a raw column of `eachChunk`, and an assignment through `each` throws at run time. So a loop that only reads no longer counts as writing for the change queries that watch what it reads, and a handler that only looks no longer copies the columns it reads, without anyone having to remember to say so.

  **Breaking**

  - `Query.reads` is gone. A query reads what it doesn't name in `Query.writes`: delete `Query.reads(...)`, and add `Query.writes(...)` with the terms the loop writes.
  - A system that writes through a query without `Query.writes` no longer compiles, and throws at run time when it assigns through `each`. Name what it writes.
  - `Query.Reading<D, R>` is now `Query.Reading<D>`, every term marked read-only, and `Query.Writing<D, W>` unmarks the terms in `W`.
  - A save keeps a change query's position under a description that includes what it reads. A change query that now reads a term it used to write is another query to a save made before this change, and starts by visiting everything.

- [#172](https://github.com/lucasthevenet/arcadekit/pull/172) [`4297ae0`](https://github.com/lucasthevenet/arcadekit/commit/4297ae0d7deb89133c3ebeb2450c93c1dce6e1a0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A state's handle and `Gltf.model` refuse, with a message that says what is wrong, what they used to pass on unchecked.

  **Breaking**

  - A state's handle throws on reading a value that is not one of the state's values, as a save from an older game can hold, where it returned that value. A migration renames a state's values in a save.
  - `Gltf.model` fails with `Assets.AssetFailed` for a document whose `buffers`, `bufferViews` or `images` are not lists of what glTF has there, where it went on with them.

- [#217](https://github.com/lucasthevenet/arcadekit/pull/217) [`46cb1c5`](https://github.com/lucasthevenet/arcadekit/commit/46cb1c58bbe56eb4b9e8d84004595b018bcd4f6b) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A save and a moment no longer leave a running script behind with no error, and `@arcadekit/three` disposes of the geometries and materials of `Three.instances` and `Three.objects` once no system draws with them.

  **Breaking**

  - `app.capture()` fails with `Save.SaveRefused` while a script is running, and a rewind no longer starts a plugin's scripts again. A rollback session stops with that error on a game whose script is running: do what the script did with systems and states.
  - `app.save()` fails with `Save.SaveRefused` while a script started with `app.spawnScript` or `Script.spawn` is running. Save once it has ended. A plugin's `scripts` still start again after a load.
  - `@arcadekit/three` disposes of the geometry and material given to `Three.instances` or returned by `look`, and of the geometries and materials of what `make` of `Three.objects` built. Drop a `free` that only disposed of them. One that disposes of them too still works.

- [#277](https://github.com/lucasthevenet/arcadekit/pull/277) [`2aafa7a`](https://github.com/lucasthevenet/arcadekit/commit/2aafa7a0e8cde8dd58ae0e8ecd50345abda5b194) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A system's stage is in its type. `System.tick`, `System.frame` and `System.input` refuse a body that uses the other stages, and `App.define` and `Plugin.make` refuse two systems, handlers or plugins that share a name.

  **Breaking**:

  - `System.make` is removed. A system of the tick is `System.tick`, one that draws or plays is `System.frame`, and one that reads the devices is `System.input`.
  - `System.inStage` only moves a system inside the group it was made in: `"preUpdate"` and `"postUpdate"` for a tick, `"preFrame"` and `"postFrame"` for a frame. The input stage is `System.input`.
  - `State.onEnter` and `State.onExit` are `State.onEnter(state, value, name, body)` and `State.onExit(state, value, name, body)`. They are not pipes.
  - Emitting is `yield* Event.emits`, setting a state is `yield* State.sets`, and writing a singleton is `yield* Singleton.writes`. `yield*` on the definition reads. A frame or input system cannot require those.
  - `Sound.Player` and `View.Port` cannot be required by a tick system or an input system. `Input.Devices`, `Frame`, `View.Intake` and `Assets.Store` cannot be required by a tick system.
  - `Action.handler` and a plugin's `setup` take what a tick system takes. `System.runIf` and `System.otherwise` take what the system's stage takes.
  - A tuple of systems, handlers or plugins with one name twice does not compile. A list that is not a tuple is still refused when the app is made.

- [#292](https://github.com/lucasthevenet/arcadekit/pull/292) [`359ce0f`](https://github.com/lucasthevenet/arcadekit/commit/359ce0f18b45743a3c839ff505f1a776739c641d) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Three.texture`'s `prepare` is handed the texture without its `flipY`, so setting it there no longer compiles. It used to compile and fail the load, since Three.js does not read `flipY` of a texture made of a bitmap.

  **Breaking**

  - `prepare` takes an `Omit<Texture, "flipY">`. A game that set `texture.flipY` in `prepare` passes `Three.texture(url, { flipY })` instead, and a `prepare` written as a function of a whole `Texture` takes the narrower type.

- [#294](https://github.com/lucasthevenet/arcadekit/pull/294) [`d2153da`](https://github.com/lucasthevenet/arcadekit/commit/d2153da298ac689848532e934492e4961adba155) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - What colour an entity is drawn in is arcadekit's, as where it is drawn is: `arcadekit/Color` gives one component, `Color.Rgb`, of three 32-bit floats and the `space` they are written in, `Color.Srgb`, as a hex code writes a colour, from 0 to 1, or `Color.Linear`, a renderer's own numbers, over 1 for a colour brighter than white. It is white when added bare. `Three.instances(name, { ..., color: Color.Rgb })` draws each entity by the space of its own colour, so entities of one kind can have either. A component of the game's own does not compile as `color`, so neither one of mixed kinds of field nor one of bytes can be passed.

  **Breaking**

  - `Three.instances` no longer takes a colour component of the game's. A game that wrote `const Paint = Component.define("game/Paint", { r: Field.f32, g: Field.f32, b: Field.f32 })` and `color: Paint` spawns `Color.Rgb.of({ r, g, b, space: Color.Srgb })` and writes `color: Color.Rgb`.
  - `colorSpace` is removed. A game that wrote `colorSpace: "srgb-linear"` gives its entities colours whose `space` is `Color.Linear`.
  - A colour in bytes, fields of `Field.u8`, is no longer read. A game that held `{ r: 0xff, g: 0x61, b: 0x88 }` writes `Color.Rgb.of({ r: 0xff / 255, g: 0x61 / 255, b: 0x88 / 255, space: Color.Srgb })`.
  - `Three.ColorComponent` is removed.
  - The two refusals when the system was made, of a component that is no colour and of one whose fields are of mixed kinds, are gone, since neither can be written. A number below 0 or over 1 in `Color.Srgb` still fails the frame, naming the entity, and so does a `space` that is neither.

  Nothing breaks in `arcadekit`: `Color` is new.

- [#333](https://github.com/lucasthevenet/arcadekit/pull/333) [`485fc23`](https://github.com/lucasthevenet/arcadekit/commit/485fc2382c3b9724178fe8a7f9f0f6464f4a8fc0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A Three.js loader that fetches files of its own can fetch them through `Assets.Loader`. `Three.manager(files)` fetches the files through `Assets.Loader` and returns a Three.js `LoadingManager` that serves them to any loader made with it, and refuses any other URL with an error that names it. `Gltf.model` takes the files its decoders fetch as `files`, and hands `prepare` the manager that serves them, so a test's in-memory files serve a compressed model's decoders, and leaving a level cancels their requests.

  **Breaking**

  - A DRACO or KTX2 loader set in `Gltf.model`'s `prepare` is made there, with the manager `prepare` receives, and its files are listed in `files`: `{ files: ["/draco/draco_decoder.wasm", "/draco/draco_wasm_wrapper.js"], prepare: (loader, manager) => loader.setDRACOLoader(new DRACOLoader(manager).setDecoderPath("/draco/")) }`. A decoder made without that manager fails the bundle with `Assets.AssetFailed`.
  - The decoder is disposed of once the model is read, so one decoder is no longer shared between models.

- [#357](https://github.com/lucasthevenet/arcadekit/pull/357) [`1f10d64`](https://github.com/lucasthevenet/arcadekit/commit/1f10d64ed52ec445d0425288d8a8a5ff1a554237) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The parts of `@arcadekit/three/Three` are modules and entries of their own, each with its page in the reference: `@arcadekit/three/Scene`, `@arcadekit/three/Renderer`, `@arcadekit/three/Assets` (`texture` and `manager`), `@arcadekit/three/Instances` and `@arcadekit/three/Objects`. `Three` re-exports each, so either import gives the same values. Their implementation is in `src/internal/`, which is no entry.

  Nothing breaks: `@arcadekit/three/Three` and `import { Three } from "@arcadekit/three"` give what they gave. The new entries only add.

- [#136](https://github.com/lucasthevenet/arcadekit/pull/136) [`3e84560`](https://github.com/lucasthevenet/arcadekit/commit/3e845603b4eaba2308427222020183a0deda9a58) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A new package: draws an arcadekit game with Three.js.

  - It draws from arcadekit's own components for where a thing is, `arcadekit/Transform3d` and, for a flat game, `arcadekit/Transform2d`, in the plane of x and y, and has none of its own: the plugins that hold a game's rules, a server and a replay import nothing of this package and install no renderer.
  - `Three.instances(name, { of, geometry, material })` draws every entity of a kind, where its `Transform3d.Position` says and turned and sized by its `Transform3d.Rotation` and `Transform3d.Scale`, as one instance of one mesh: a system of the frame stage that reads the columns raw and writes one matrix per entity straight into the mesh's buffer. Nothing is allocated per entity per frame: ten thousand moving objects cost about 0.1 to 0.4 ms a frame before Three.js takes over. A `Rotation` of any length is drawn as the turn it stands for, neither skewed nor sized by it.
  - With `color: Paint`, a component of the game's with the fields `r`, `g` and `b`, each instance is drawn in a colour of its own, read from the columns in the same pass, for about 6 ns more per entity. The package defines no such component: a colour is the game's to say, as a place is. Its numbers are a hex code's, `0xff / 255` in fields of floats or the bytes themselves in fields of whole numbers, converted for the renderer through a table; one that is out of range fails the frame with the entity's name. `colorSpace: "srgb-linear"` hands over the renderer's own numbers as they are.
  - `Three.objects(name, { of, make, free })` keeps one Object3D per entity, made when the entity first matches and let go when it no longer does, and copies the entity's place into it each frame.
  - A look that is made of a level's assets: `Three.instances(name, { of, from: Forest, look: ({ bark }) => ({ geometry, material }), free })` draws its entities while the app holds the bundle loaded, in a look made of it once each time it is loaded and handed to `free` when it is let go; `Three.objects(name, { of, from: Forest, make: (entity, assets) => ... })` makes its objects of them the same way. Nothing is drawn with assets that were let go, whatever order the systems run in. `Three.texture(url, { prepare, flipY })` is the asset that is a texture, disposed of with the scope it was loaded in. Which way up it is, is said with `flipY` where it is made: set in `prepare`, which Three.js would not read, it fails the load with an error that says so.
  - With `smooth: true`, either draws each entity between its last two places, at `Frame.alpha` of the way from where it was a tick ago to where it is, so that a game whose ticks and frames do not line up moves evenly, a tick behind. `snap` is how far an entity may go in a tick and still be drawn on the way. What it keeps is the renderer's own, never the world's.
  - `Three.plugin` gives an app a scene and a camera, `Three.Scene`, and draws them once per frame with `Three.Render`, through `Three.Renderer`, which comes from outside: `Three.layerWebGL({ canvas })` in a page, fitted to the size the canvas has there, or `Three.layerRenderer(make)` for a renderer of your own.
  - Models: `Gltf.model(url)`, from `@arcadekit/three/Gltf`, is the asset that is a glTF file, `.glb` or `.gltf`. The buffers and pictures a `.gltf` names are fetched through `Assets.Loader` and handed to Three.js with it, and its geometries, materials and textures are disposed of with the scope it was loaded in. `Gltf.mesh(model, name)` is one of its meshes, for a look. It is a module of its own, so that a game with no models does not carry the loader.
  - `Three.Render` is in the stage after a frame's own, `"postFrame"`: everything that draws, and a system that moves the camera, has run when it does, with nothing said about order.
  - All of it runs in the frame stage and reads the world: a game that is drawn has the same hash, log and save as one that is not.
  - What it knows an entity by is its whole id, which is past what 32 bits hold once the entity's slot has been given out 1,024 times: such an entity keeps its object and its place between two ticks.

  Nothing breaks: the package is new. It needs `arcadekit`, `effect` and `three` as peers.

### Patch Changes

- [#525](https://github.com/lucasthevenet/arcadekit/pull/525) [`ba281a6`](https://github.com/lucasthevenet/arcadekit/commit/ba281a6f7f2d8a094f13f4827b6c88450a271728) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A kind drawn with `smooth: true` allocates about 3.5 KB less each frame. It asked the app for all three stores of what was drawn a tick ago, those of `Transform3d.smooth`, `Transform2d.smooth` and `Color.smooth`, together, and now asks for the one of its transform, and for the colour's only when it has a colour. A frame of 10,000 entities drawn smoothly allocates 600 to 800 bytes more than one drawn where the last tick left them, where it allocated about 4 KB more. Nothing breaks.

- [#526](https://github.com/lucasthevenet/arcadekit/pull/526) [`953717f`](https://github.com/lucasthevenet/arcadekit/commit/953717f8a3e73a846296b7cfc7e338c4fc993d05) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An entity counts its own teleports, and everything that draws it between two ticks draws it where it landed. `Transform2d.Teleports` and `Transform3d.Teleports` hold a `count`, which the tick that teleports an entity adds one to. Every reader of `Transform2d.smooth` and `Transform3d.smooth`, and every kind of `@arcadekit/three` drawn with `smooth: true`, then draws the entity at its position, rotation and scale until the next tick, with no `snap` given, so two readers can no longer draw one teleport two ways. The count is a component of the game: a rewind takes a teleport back, and a peer that hears of one late draws the entity where it landed. An entity without it costs nothing.

  **Breaking**: `Transform2d.smooth` and `Transform3d.smooth` require `World` beside `Frame` and `Time`. A frame system has all three, so a game that yields them there changes nothing; one that provides them by hand provides `World` too. `snap` stays, for a long move the game doesn't count as a teleport.

- [#353](https://github.com/lucasthevenet/arcadekit/pull/353) [`1de8ca9`](https://github.com/lucasthevenet/arcadekit/commit/1de8ca907ab8ccf133891788e7a225c3d78fd614) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An `Entity`, an `Entity.Ref` and a `Spawned` id are no longer numbers to the compiler. A `Uint32Array`, a number field such as `Field.u32`, and arithmetic or a bitwise operator kept only an id's low 32 bits, and lost the generation of a slot reused more than 1,023 times with no error. None of them takes an id now. An id is still a number when the game runs, so JSON, saves, snapshots and the hash are unchanged. An `Entity` is still an `Entity.Ref`, and an `Entity.Ref` still not an `Entity`.

  **Breaking**:

  - An id compares with `===` and keys a `Map` or a `Set`. Code that added to an id, sorted ids with `a - b`, or took its bits with `&` or `>>>` reads its parts with `entityIndex` and `entityGeneration` instead:

    ```ts sketch
    // before
    ids.sort((a, b) => a - b);
    const slot = entity & 0x3f_ff_ff;
    // now
    ids.sort((a, b) => entityIndex(a) - entityIndex(b));
    const slot = entityIndex(entity);
    ```

  - The `entities` column that `eachChunk` hands out is an `EntityColumn`, a `ReadonlyColumn<Entity>`, and no longer a `Float64Array`. A `Field.entity` of a term the query writes is a `WritableColumn<Entity.Ref>`. Both are indexed as before, and neither has the methods of a typed array.
  - `SparseColumns.indexOf` takes an `Entity`.
  - An id written into a template string reads as a number at run time, as before, but a type-aware lint that refuses an object there now refuses an id. Write its parts instead.
  - `@arcadekit/three` names the entity of a colour that is no colour by its slot and generation.

- [#275](https://github.com/lucasthevenet/arcadekit/pull/275) [`63a5fd1`](https://github.com/lucasthevenet/arcadekit/commit/63a5fd1d74f2142212f179807c5e49984c56275e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A list of systems in which one would react a tick late to another doesn't compile. A system that watches a component with `Query.changed`, listed ahead of a system that writes it in the same tick, saw the write on the next tick, with no error. Now `App.define` and `Plugin.make` refuse that list, and the error names the two systems and says which to list after the other.

  Nothing is declared. Yielding a query puts what it writes and watches in the requirements, as `Query.Writes<"game/Position">` and `Query.Watches<"game/Position">`, so a system's type says it, through a branch, a condition or another Effect alike. The app provides them, since they stand for nothing at run time. The check follows the order a tick runs: stage by stage, a plugin's dependencies before the plugin, plugins before the app's own. Hooks, handlers, and the frame and input stages run at another moment and are left out.

  **Breaking**:

  - A list with a watcher ahead of its writer no longer compiles. List the watcher after the writer, or place it in a later stage.
  - `System.System` has three more type parameters, for the system's name, its stage and what triggers it: `System<E, R, N, St, Tr>`. `System.System<E, R>` is still any system of that error and those requirements. A function's `ReturnType` that was used as the type of any system now names one system: write `System.System<E, R>`.
  - `Query.Query` has a second type parameter, the names of the components it watches, and yielding a query requires `Query.Needs<D, W>` where it required `World`. `Plugin.Plugin` has a seventh, its systems in order.
  - A query that writes or watches can't be yielded outside an app by providing `World` alone. Code outside the simulation reads it from the world:

  ```ts
  // Before
  const moved = yield * Moved.pipe(Effect.provideService(World, app.world));

  // Now
  const moved = app.world.view(Moved);
  ```

  `@arcadekit/three` draws as before: the types of its queries say that they only read.

- [#476](https://github.com/lucasthevenet/arcadekit/pull/476) [`48fd05d`](https://github.com/lucasthevenet/arcadekit/commit/48fd05dcf019035ea018f7ebae8a66e13b20f2e4) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game names what its player does as a control, binds it to the devices, and reads it in its rules, which name no key. `Input.button(name, codes)` is held while any of its codes is down, and `yield*` gives `{ held, pressed, released }`. `Input.axis(name, { negative, positive, pad })` is a number from -1 to 1, from two sets of keys and a gamepad's axis. `Input.stick(name, { left, right, up, down, pad })` is `{ x, y }`, y up and of length 1 at most, so two keys held together make a diagonal of length 1, with a radial dead zone for the gamepad's stick, 0.2 by default. `Input.controls(name, controls)` declares them in a plugin, and a game that reads a control it doesn't declare doesn't compile: `App.make` requires `Input.Declared<"game/Jump">`. The input stage works out what each control says with the app's bindings and reports it in `Input.Report` beside the devices' codes, so a recording and a rollback session play the same presses with no devices and whatever the bindings. A tick reads a control as it is in that tick, a frame system what changed since the last frame, and an input system what this sample says.

  Bindings are settings, outside the world, the save and the hash, each app its own: a frame or input system changes them with `Input.rebind(control, bindings)` and reads them with `Input.bindingsOf(control)`, and a tick that rebinds doesn't compile. A settings menu, which runs outside every system, takes `Input.settingsOf(app, Controls)`, whose `rebind` and `bindingsOf` take only the controls `Controls` declares, and keeps them in a setting of the control's schema, `Setting.define("game/JumpKeys", Jump.schema, Jump.bindings)`, which the page applies when the game starts. A code is a type: `Input.KeyCode` lists the values of `KeyboardEvent.code`, and `Input.ButtonCode` and `Input.AxisCode` add the pointer's and the gamepads' templates, so `"Spce"` doesn't compile where a code goes. `Input.isKeyCode` checks a string, and `Input.padStick(pad, "left" | "right")` names a standard gamepad's sticks. In an input system, `Input.Keyboard`, `Input.Pointer` and `Input.Gamepad` read the stage's sample, so `Three.toPlane(yield* Input.Pointer)` turns a click into a place of the game.

  **Breaking**:

  - `Input.bind`, `Input.onPress`, `Input.onRelease`, `Input.onMove`, `Input.Binding` and `Input.PayloadOf` are gone. A game declares a control and reads it in its rules, or issues its own action from an input system: `if ((yield* Jump).pressed) (yield* Action.Actions).enqueue(Leap, {})`. The walkthrough's `Input.onRelease(["ArrowLeft", "ArrowRight"], Move, { dx: 0 })`, which stopped the basket while the other arrow was held, is an `Input.axis` its rules read.
  - A code is no longer a `string`: `Input.ManualSource`'s `press`, `release`, `tap` and `move`, `Input.Sample`, `Input.KeyboardView.down`, and `Browser.layer`'s `preventDefault` take the codes' types, and `pointerButton`, `padButton` and `padAxis` return them. `Input.Keyboard` reads keys only, not a pointer's or a gamepad's button. A page's listener hears no key whose code isn't an `Input.KeyCode`.
  - In an input system, `Input.Keyboard`, `Input.Pointer` and `Input.Gamepad` read the stage's sample of the devices, where they read the world's state as of the last tick.
  - `Input.plugin` no longer suggests `Input.bind` for several players: such a game issues actions that carry the player from an input system that reads `Input.Devices` or its controls.
  - In `@arcadekit/three`, `Camera.toPlane`'s example and the flat game's test read a click as a control and the pointer from `Input.Pointer`. Nothing of its API changes.

- [#156](https://github.com/lucasthevenet/arcadekit/pull/156) [`dc1e4bc`](https://github.com/lucasthevenet/arcadekit/commit/dc1e4bc62b6f82d2c136ec92b2129c388cb5a834) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The doc comments of every export are rewritten in plain, present-tense English, so the Reference pages and editor tooltips read the way the rest of the site does, and they no longer recount how the storage core's entity ids used to be laid out. The READMEs drop their link to the site's "Not done yet" page, which is gone: the site describes arcadekit as it is, and what is not built is in the repository's roadmap. Nothing breaks.

- [#317](https://github.com/lucasthevenet/arcadekit/pull/317) [`5f8699c`](https://github.com/lucasthevenet/arcadekit/commit/5f8699c2afc6fbf391840172fc35a35f1785738a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The doc comments of every export are edited to one thought per sentence, with caveats under **Gotchas**, and corrected where they were wrong about the code. Among the corrections: a message for a tick that already ran makes a session go back rather than being dropped, `yield*` on a state returns a `StateView`, a tick never runs the input stage itself, and requiring `Sound.Player` in the simulation doesn't compile rather than throwing. `System.spanLevel` is now `@internal` and leaves the reference. Nothing breaks.

- [#161](https://github.com/lucasthevenet/arcadekit/pull/161) [`f76410d`](https://github.com/lucasthevenet/arcadekit/commit/f76410dd5c56b302a5cd55d1b03c394f69cc1e00) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The build writes each source file to a file of its own in `dist/`, `dist/ecs/world.js` for `src/ecs/world.ts`, in place of chunks shared between entries. An entry now loads only the modules it reaches, and imports only the packages they import.

  Nothing breaks: the entries, and what each one gives, are the same.

- [#368](https://github.com/lucasthevenet/arcadekit/pull/368) [`b4fd6ce`](https://github.com/lucasthevenet/arcadekit/commit/b4fd6cee23a25d2ff1b8d66cec2f3293572273af) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Query.maybe` makes a term of `Query.all` that an entity may lack: `Query.all(Position, Query.maybe(Rotation), Query.maybe(Scale))` visits every entity with a `Position`, and hands its loop the rotation and the scale where the entity's table has them, and `undefined` where it doesn't. `each` passes an accessor or `undefined`, and `eachChunk` the columns or `undefined` for a whole run, so a loop tests once per run in place of one query for each combination. It takes only a component stored in tables, and `Query.changed` and `Query.added` don't take it.

  `Three.instances` and `Three.objects` each draw a kind with one such query, where they used up to eight and three. Instances of a kind may now be filled in another order, which nothing promised.

  Nothing breaks.

- [#154](https://github.com/lucasthevenet/arcadekit/pull/154) [`7a2bfe8`](https://github.com/lucasthevenet/arcadekit/commit/7a2bfe881e8d6cc7c762ec594be7b1f6e71a942e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The READMEs are a description and links. What they explained is on [arcadekit.dev](https://arcadekit.dev), in the guides and the concepts, with what is not built yet on a page of its own, and the doc comments of the exports say what the READMEs said of them. Nothing breaks.
- Updated dependencies [[`99e782c`](https://github.com/lucasthevenet/arcadekit/commit/99e782c8c60402e5425921ca01bfa7e8f81a421b), [`99c7ac6`](https://github.com/lucasthevenet/arcadekit/commit/99c7ac6c738351cbcdb4026aa0be54816aa1a74d), [`99feb2d`](https://github.com/lucasthevenet/arcadekit/commit/99feb2d1762692209abba062ad87ee4defa8362f), [`b60ff97`](https://github.com/lucasthevenet/arcadekit/commit/b60ff974893ddf64558bbd05172323a66394c37e), [`249ed59`](https://github.com/lucasthevenet/arcadekit/commit/249ed59aecee67253793852d27849358e45ff4e4), [`e26b295`](https://github.com/lucasthevenet/arcadekit/commit/e26b295c0e07be647a662bb7e882f842f5fc3122), [`717ba6c`](https://github.com/lucasthevenet/arcadekit/commit/717ba6c66397c33c107699b09704d2026f3c6e4f), [`aa4912e`](https://github.com/lucasthevenet/arcadekit/commit/aa4912edbc38bd7c049afa0e25580205912234ce), [`10917fd`](https://github.com/lucasthevenet/arcadekit/commit/10917fdda5e2e579baaa39fcf567235ecdd252b9), [`8feb2cc`](https://github.com/lucasthevenet/arcadekit/commit/8feb2ccae37021134e67b701307d5dfc634e6a87), [`95f21d9`](https://github.com/lucasthevenet/arcadekit/commit/95f21d9c01debf4bd355b0fe56c3beeee89de62f), [`ef36674`](https://github.com/lucasthevenet/arcadekit/commit/ef3667454ae5ca6ae10ba58271dacd9e7f5d4bc9), [`f071651`](https://github.com/lucasthevenet/arcadekit/commit/f0716512e30bd36fdc48ced09371d1deeb742233), [`0b33306`](https://github.com/lucasthevenet/arcadekit/commit/0b333063795fb0e8c2a74b649c4687a2b00a22a1), [`6ab5c56`](https://github.com/lucasthevenet/arcadekit/commit/6ab5c564bf7c0554bde0220adfca3fbea754ee39), [`bec034f`](https://github.com/lucasthevenet/arcadekit/commit/bec034f86adf211c244d7bf5cab1d4001bdbd891), [`ca21988`](https://github.com/lucasthevenet/arcadekit/commit/ca2198831b342f3efe991998cee88e66a08d3e08), [`98616eb`](https://github.com/lucasthevenet/arcadekit/commit/98616eba74c3279b29d65abf8885ed503ea7fdf4), [`9bdd5bd`](https://github.com/lucasthevenet/arcadekit/commit/9bdd5bd7d57430fa7877c962f0f247eac0721845), [`8994d25`](https://github.com/lucasthevenet/arcadekit/commit/8994d255de000bc0e2d091a067654008104730fb), [`40201e8`](https://github.com/lucasthevenet/arcadekit/commit/40201e893dad0297ed87801d3eae25625e6d1097), [`d2ad7f1`](https://github.com/lucasthevenet/arcadekit/commit/d2ad7f1dfb52894537da48cf048c2c3d572e6b47), [`43ea5c0`](https://github.com/lucasthevenet/arcadekit/commit/43ea5c04a76539b0392fe35ccc3b3277361c2b19), [`9380d16`](https://github.com/lucasthevenet/arcadekit/commit/9380d166636b438241f6c076a49f6cfe9e0663ea), [`5df4310`](https://github.com/lucasthevenet/arcadekit/commit/5df431085e9d9aebe2cbaa6d6529965fff9e1df4), [`6be34e3`](https://github.com/lucasthevenet/arcadekit/commit/6be34e39948e989a41f29e9faaab454cbf357db1), [`7b81085`](https://github.com/lucasthevenet/arcadekit/commit/7b81085bf69d83bb4088db62c29cfdc6b6ac1130), [`6026e50`](https://github.com/lucasthevenet/arcadekit/commit/6026e50cb71e62451d935c8cb71d23d3f9eabf37), [`b9c182a`](https://github.com/lucasthevenet/arcadekit/commit/b9c182ad574a17ed1afd1aa88d5a0d7dd64879ec), [`0adb1e0`](https://github.com/lucasthevenet/arcadekit/commit/0adb1e0e9c28ac484e3b8fea198984df4883949c), [`3938a54`](https://github.com/lucasthevenet/arcadekit/commit/3938a543e015b593515cf4d27d0a2e2081bb54d8), [`f528900`](https://github.com/lucasthevenet/arcadekit/commit/f528900240d5760de79d2fdac830c48b4530569d), [`923908d`](https://github.com/lucasthevenet/arcadekit/commit/923908d56563732b3235e5692f2a592d5eb7666f), [`a608613`](https://github.com/lucasthevenet/arcadekit/commit/a608613dd8b86e2df9106c93914e8ce171d01ea0), [`38d46bd`](https://github.com/lucasthevenet/arcadekit/commit/38d46bd845b05c7f3e4341309b10c8ba99879491), [`8fc89d0`](https://github.com/lucasthevenet/arcadekit/commit/8fc89d06ee2d3452fc789db9594c19cd91b70057), [`398f410`](https://github.com/lucasthevenet/arcadekit/commit/398f410857603233253af43723dfd667933182e2), [`b788248`](https://github.com/lucasthevenet/arcadekit/commit/b78824872d0a8927a660a8c64a84ac7dc35b43eb), [`01c6a8b`](https://github.com/lucasthevenet/arcadekit/commit/01c6a8b7bc72492d08f5dd60a078b0ce785f1fcb), [`e2eb0c4`](https://github.com/lucasthevenet/arcadekit/commit/e2eb0c4f3279d1f89ea707b7c93980ac67939663), [`2e95176`](https://github.com/lucasthevenet/arcadekit/commit/2e95176e32490fa5405a97213826cb7bae78538f), [`23874b0`](https://github.com/lucasthevenet/arcadekit/commit/23874b09f6ee43bedcb353599008d99ebb4d7f71), [`b3e03a3`](https://github.com/lucasthevenet/arcadekit/commit/b3e03a3e8d1f0efcf238d231a5aaa2680fda268e), [`92ff42d`](https://github.com/lucasthevenet/arcadekit/commit/92ff42ded98ff31115ca694972be82a5068b74e0), [`af22917`](https://github.com/lucasthevenet/arcadekit/commit/af2291704bed03e15758889e7c253ed187dccf62), [`7d71f4a`](https://github.com/lucasthevenet/arcadekit/commit/7d71f4ade2458869a3cbdabeef9c2fd3f56156cc), [`97b37c3`](https://github.com/lucasthevenet/arcadekit/commit/97b37c314d499c3e586f3badce182ddd76ccf3c9), [`af2f006`](https://github.com/lucasthevenet/arcadekit/commit/af2f0064f44d4c0f53e2ca6d912596cb1cb7cbab), [`da22104`](https://github.com/lucasthevenet/arcadekit/commit/da221044bc8aa3f40a2e4c7b8ca70d118b516ead), [`03ddcbb`](https://github.com/lucasthevenet/arcadekit/commit/03ddcbbca8dcce077b898b2a2a99e785f2e1349b), [`2411d97`](https://github.com/lucasthevenet/arcadekit/commit/2411d97bbc48a1036189cfd2b9c044e49295d3ee), [`2a6edb3`](https://github.com/lucasthevenet/arcadekit/commit/2a6edb3cc1ea43db2d190f2440e4d28706662cd7), [`34ffc3f`](https://github.com/lucasthevenet/arcadekit/commit/34ffc3fd6aab83561cfd98103bfc06f6f9888dc5), [`5d8493a`](https://github.com/lucasthevenet/arcadekit/commit/5d8493af77c8c675e93404f99758a58782ef9982), [`aa2196b`](https://github.com/lucasthevenet/arcadekit/commit/aa2196bc8448752b5749305d4a10175dbc59f124), [`51d3e8a`](https://github.com/lucasthevenet/arcadekit/commit/51d3e8a79ddc08374295f3e1a6fdd53e25156c44), [`fdfd8c0`](https://github.com/lucasthevenet/arcadekit/commit/fdfd8c0458d9d46340d9b4cba42c821527cfd0da), [`3683e37`](https://github.com/lucasthevenet/arcadekit/commit/3683e375396bfc4baab888a71491ced3030e69aa), [`8fa781d`](https://github.com/lucasthevenet/arcadekit/commit/8fa781d651de3a4d88b61c4d0ac05e4c2c485216), [`bf1daec`](https://github.com/lucasthevenet/arcadekit/commit/bf1daec9691bdb1dc9efa404155806a754e543ee), [`9d973f4`](https://github.com/lucasthevenet/arcadekit/commit/9d973f4c4d30e3dfd681d4a924defad1c784c62d), [`d3d55b3`](https://github.com/lucasthevenet/arcadekit/commit/d3d55b30877d7dfc7a81284598a096f4137aaf93), [`b4ee0d4`](https://github.com/lucasthevenet/arcadekit/commit/b4ee0d4b45e47187ab83a2f2fbcd30a3b8564056), [`953717f`](https://github.com/lucasthevenet/arcadekit/commit/953717f8a3e73a846296b7cfc7e338c4fc993d05), [`1de8ca9`](https://github.com/lucasthevenet/arcadekit/commit/1de8ca907ab8ccf133891788e7a225c3d78fd614), [`d9a7584`](https://github.com/lucasthevenet/arcadekit/commit/d9a758455b86c8ce33cc876f40293f2a8b1cd8cc), [`33419e3`](https://github.com/lucasthevenet/arcadekit/commit/33419e391d31d102f09f7fb5e3c79d15200b1cff), [`63a5fd1`](https://github.com/lucasthevenet/arcadekit/commit/63a5fd1d74f2142212f179807c5e49984c56275e), [`2183526`](https://github.com/lucasthevenet/arcadekit/commit/218352600aadb7eefc1f058c40bc0c77e20d45c5), [`e409161`](https://github.com/lucasthevenet/arcadekit/commit/e409161e17bec24dd3fe6b33321186376b81404e), [`b820835`](https://github.com/lucasthevenet/arcadekit/commit/b8208350fc401dc5d66b45cf54a22e01b1bf378a), [`96d3047`](https://github.com/lucasthevenet/arcadekit/commit/96d304764f9b9250a4aae713402dc24e6c1d29e8), [`adbe2ed`](https://github.com/lucasthevenet/arcadekit/commit/adbe2ed4becca11a5dbfc6d476b573ce8382d7f6), [`ba281a6`](https://github.com/lucasthevenet/arcadekit/commit/ba281a6f7f2d8a094f13f4827b6c88450a271728), [`6e8b6ca`](https://github.com/lucasthevenet/arcadekit/commit/6e8b6ca820a7ae6cdb3ea30213aa0d5dfb8ea112), [`e3c1733`](https://github.com/lucasthevenet/arcadekit/commit/e3c17338259952b7e689d6f39eaee4109f2bb6ca), [`a7b5006`](https://github.com/lucasthevenet/arcadekit/commit/a7b5006d60f1bdb5dfe262116114d454bf704423), [`ad8256e`](https://github.com/lucasthevenet/arcadekit/commit/ad8256e85dba65688363ecddfaea5964a09571f8), [`48fd05d`](https://github.com/lucasthevenet/arcadekit/commit/48fd05dcf019035ea018f7ebae8a66e13b20f2e4), [`0009229`](https://github.com/lucasthevenet/arcadekit/commit/0009229e195dcfb668da9e61f021b05799162eef), [`fcc0b4c`](https://github.com/lucasthevenet/arcadekit/commit/fcc0b4c8e88c97231df39a690543b2e365f92d51), [`dc1e4bc`](https://github.com/lucasthevenet/arcadekit/commit/dc1e4bc62b6f82d2c136ec92b2129c388cb5a834), [`5f8699c`](https://github.com/lucasthevenet/arcadekit/commit/5f8699c2afc6fbf391840172fc35a35f1785738a), [`d124b09`](https://github.com/lucasthevenet/arcadekit/commit/d124b097a0d0f04ffc478d1fecc10281be64e76a), [`c418a02`](https://github.com/lucasthevenet/arcadekit/commit/c418a024fca9f61a6508b5667db08c21a501e5b7), [`9d034ce`](https://github.com/lucasthevenet/arcadekit/commit/9d034cef24fb50a575a40a153c2aed30b0a93eb0), [`3bf4fa5`](https://github.com/lucasthevenet/arcadekit/commit/3bf4fa56c762aaa4a365c73652c41c9611fdbe44), [`e63ad0c`](https://github.com/lucasthevenet/arcadekit/commit/e63ad0c42e0f6a10290d13b0edd6db7a738ff972), [`a321750`](https://github.com/lucasthevenet/arcadekit/commit/a3217509710d205163dc6fdd59f48081ec2f603a), [`9ff1ad3`](https://github.com/lucasthevenet/arcadekit/commit/9ff1ad312300b9f07503b45ba219e8093e4d7336), [`e543b96`](https://github.com/lucasthevenet/arcadekit/commit/e543b96ac36dfffd5cef1c2c4f7bc9f2c56f6d24), [`a695cdc`](https://github.com/lucasthevenet/arcadekit/commit/a695cdc309f0f67bbbaa6d9dcf980a0267d15829), [`c35c665`](https://github.com/lucasthevenet/arcadekit/commit/c35c665b4f2b4487c6dc0aa17a00e3ff6396a800), [`13beba4`](https://github.com/lucasthevenet/arcadekit/commit/13beba431d1e0a23df6784f8cbe908e5859f24a0), [`b77e120`](https://github.com/lucasthevenet/arcadekit/commit/b77e120da69818ecef6c27a8dec86955a1bc6cd5), [`96a5f7e`](https://github.com/lucasthevenet/arcadekit/commit/96a5f7eed461a30bb8e1b0950bc932471eb48d35), [`2734f7d`](https://github.com/lucasthevenet/arcadekit/commit/2734f7db9791f7a40c659c284040b4e9c8b7c1b3), [`ac76555`](https://github.com/lucasthevenet/arcadekit/commit/ac76555077f841c45334621ffdcd30cbfa31dc6d), [`d45e1a7`](https://github.com/lucasthevenet/arcadekit/commit/d45e1a7d264c7a901568ea6f73fbf1adc08bd32a), [`47d487a`](https://github.com/lucasthevenet/arcadekit/commit/47d487ac5893a67f0b6ced1715857ae2c35e07e4), [`e1081e9`](https://github.com/lucasthevenet/arcadekit/commit/e1081e9bc2c2dc824413817f921fb9ea400bf31e), [`afc6a22`](https://github.com/lucasthevenet/arcadekit/commit/afc6a22487442a164234b271b87850b99b4013c9), [`2448aee`](https://github.com/lucasthevenet/arcadekit/commit/2448aeecd8747de487edd4d2653fc8bdf77cda68), [`b2c81b0`](https://github.com/lucasthevenet/arcadekit/commit/b2c81b0a85cbae528843dcb5bf6587c3a597c6a0), [`943ada6`](https://github.com/lucasthevenet/arcadekit/commit/943ada68fde271010fa061fe0becd12eaa863a4f), [`146aaf4`](https://github.com/lucasthevenet/arcadekit/commit/146aaf4355bb80ed149e469b80f7e284987a8cab), [`b5261e7`](https://github.com/lucasthevenet/arcadekit/commit/b5261e7d11b47c1ce8ae7a6c88ff14b23b81f49e), [`c4d06d8`](https://github.com/lucasthevenet/arcadekit/commit/c4d06d8d3130b330fb80e52f67dd94ce3d46a433), [`2f343e9`](https://github.com/lucasthevenet/arcadekit/commit/2f343e9c4d08bac1c0c37f1142e513df56d6c747), [`f76410d`](https://github.com/lucasthevenet/arcadekit/commit/f76410dd5c56b302a5cd55d1b03c394f69cc1e00), [`46abea7`](https://github.com/lucasthevenet/arcadekit/commit/46abea7ad1b2a30d47d427846cbf560e53b7022a), [`eb9f830`](https://github.com/lucasthevenet/arcadekit/commit/eb9f8301969182792ee8954cf12aaf0dbe68796c), [`bb47fbd`](https://github.com/lucasthevenet/arcadekit/commit/bb47fbd1a1d9d224cc93013ef41426f5c2914c7c), [`f751434`](https://github.com/lucasthevenet/arcadekit/commit/f75143465b9075f5b7c405731fcc48973f780597), [`49fab38`](https://github.com/lucasthevenet/arcadekit/commit/49fab38a9648635ed2383087de8d9bc01149a436), [`40e1d13`](https://github.com/lucasthevenet/arcadekit/commit/40e1d138513efe69acb91a6988e1e68c407ee9f2), [`3bf76af`](https://github.com/lucasthevenet/arcadekit/commit/3bf76af15b5a106be58cb218bb57907e744827a9), [`cfa1292`](https://github.com/lucasthevenet/arcadekit/commit/cfa1292f2a5609dca715d7d264008291ed18511f), [`054a34c`](https://github.com/lucasthevenet/arcadekit/commit/054a34c34e2ad3273f35ed15e9aa5feadc5ee56f), [`b4fd6ce`](https://github.com/lucasthevenet/arcadekit/commit/b4fd6cee23a25d2ff1b8d66cec2f3293572273af), [`44f02e9`](https://github.com/lucasthevenet/arcadekit/commit/44f02e94ac01f9f7d37a6357d43bc953c9b08cf6), [`5b630ce`](https://github.com/lucasthevenet/arcadekit/commit/5b630cee8bd6cf6375d9b900c121564d9cb015cc), [`30c7df1`](https://github.com/lucasthevenet/arcadekit/commit/30c7df11df12640a5bd3652a0e8a68c099c6394a), [`ffbbcd3`](https://github.com/lucasthevenet/arcadekit/commit/ffbbcd36b8ddf28d8af754d05a17b5dc015b3a00), [`22032d9`](https://github.com/lucasthevenet/arcadekit/commit/22032d9ec757b83cd895c19db01f7751e40482ea), [`0e63aa7`](https://github.com/lucasthevenet/arcadekit/commit/0e63aa7ee3a1d51c8d520a200ecc06002671ad04), [`4297ae0`](https://github.com/lucasthevenet/arcadekit/commit/4297ae0d7deb89133c3ebeb2450c93c1dce6e1a0), [`3683e37`](https://github.com/lucasthevenet/arcadekit/commit/3683e375396bfc4baab888a71491ced3030e69aa), [`3683e37`](https://github.com/lucasthevenet/arcadekit/commit/3683e375396bfc4baab888a71491ced3030e69aa), [`cdd5655`](https://github.com/lucasthevenet/arcadekit/commit/cdd5655f76b6c043868c20bdd190310ebc1867bf), [`03651e8`](https://github.com/lucasthevenet/arcadekit/commit/03651e83c1c49f504430a675bedf07d48fcf01b3), [`90dff63`](https://github.com/lucasthevenet/arcadekit/commit/90dff63402aee481447dd1a5e87e232fc751e269), [`bac33b5`](https://github.com/lucasthevenet/arcadekit/commit/bac33b5a5edd2e743ba20ad2f85665eb7fa67973), [`728d196`](https://github.com/lucasthevenet/arcadekit/commit/728d1964f8cdafc8e5e13e8dad1c2dfacdf2607f), [`1e72c83`](https://github.com/lucasthevenet/arcadekit/commit/1e72c835ca56c5bbd4f7216b8ce075cbeaed5491), [`46cb1c5`](https://github.com/lucasthevenet/arcadekit/commit/46cb1c58bbe56eb4b9e8d84004595b018bcd4f6b), [`7a2bfe8`](https://github.com/lucasthevenet/arcadekit/commit/7a2bfe881e8d6cc7c762ec594be7b1f6e71a942e), [`0b8d0a5`](https://github.com/lucasthevenet/arcadekit/commit/0b8d0a5e0fe7a57225ed31cc4fdd241da6ab3ea1), [`bf3e1a9`](https://github.com/lucasthevenet/arcadekit/commit/bf3e1a9b0690a81f37b99c93e546c76f92e28a4e), [`cdbe551`](https://github.com/lucasthevenet/arcadekit/commit/cdbe5518081359cf395e191147640255cda634a0), [`3683e37`](https://github.com/lucasthevenet/arcadekit/commit/3683e375396bfc4baab888a71491ced3030e69aa), [`2aafa7a`](https://github.com/lucasthevenet/arcadekit/commit/2aafa7a0e8cde8dd58ae0e8ecd50345abda5b194), [`3fc2610`](https://github.com/lucasthevenet/arcadekit/commit/3fc2610f10ab1039cacd973977d623d22cd996bf), [`8d502d1`](https://github.com/lucasthevenet/arcadekit/commit/8d502d11518db975a7245f698871dfe2d38f48a6), [`809e7eb`](https://github.com/lucasthevenet/arcadekit/commit/809e7eba90b9f64d009166aacb943198b170d444), [`d2153da`](https://github.com/lucasthevenet/arcadekit/commit/d2153da298ac689848532e934492e4961adba155), [`82f9836`](https://github.com/lucasthevenet/arcadekit/commit/82f98361abfeed034e5cc1ffc58da0a13538d9f0), [`878ddb4`](https://github.com/lucasthevenet/arcadekit/commit/878ddb417be6660b732ce44e1e6159888091557c), [`d476a46`](https://github.com/lucasthevenet/arcadekit/commit/d476a46ffaaf793f2b1b6cff1419c7184eb02bf2), [`4857bc3`](https://github.com/lucasthevenet/arcadekit/commit/4857bc349ff0f0eb16908f14b0233b655ebbb484), [`347178f`](https://github.com/lucasthevenet/arcadekit/commit/347178fef9351b018394d423459b115923537f7e), [`18f7696`](https://github.com/lucasthevenet/arcadekit/commit/18f769617b6b304a19fe5b43820259ff4e7e2b11), [`325ff5d`](https://github.com/lucasthevenet/arcadekit/commit/325ff5d06fdf7e648309dbfdcf45af7602257ec4), [`63d43ae`](https://github.com/lucasthevenet/arcadekit/commit/63d43ae40a949da86d11ace1b33d8c667dc246b6), [`5786809`](https://github.com/lucasthevenet/arcadekit/commit/5786809ebc734f08460f2efe7a39b16e8ba1c3b5), [`fa3eb1a`](https://github.com/lucasthevenet/arcadekit/commit/fa3eb1a8d7ec23c4ddac0e83905174732db6ff6a), [`656db0e`](https://github.com/lucasthevenet/arcadekit/commit/656db0e3a97cf1e621a402846c21eec8ff7c4239), [`0103057`](https://github.com/lucasthevenet/arcadekit/commit/0103057efa0b3040aa212a47df15168051ab9633), [`322a8ef`](https://github.com/lucasthevenet/arcadekit/commit/322a8efe0bef4c63b98799cbd1eec9bc414ebbe6), [`c8a0cc1`](https://github.com/lucasthevenet/arcadekit/commit/c8a0cc1ea97571c92279aa4eaaf63acdad2e4141), [`d699901`](https://github.com/lucasthevenet/arcadekit/commit/d699901cff61f605544f47ffdd2282701b255344), [`86e50ad`](https://github.com/lucasthevenet/arcadekit/commit/86e50addcd673e947dad8476ee1a3cf906186b2d), [`4a8f2cf`](https://github.com/lucasthevenet/arcadekit/commit/4a8f2cf9075af91f48f6518200940021edab2dc0), [`fb20c3b`](https://github.com/lucasthevenet/arcadekit/commit/fb20c3be3adbc28fa487697ef4be19d22b9848b8), [`82b7d03`](https://github.com/lucasthevenet/arcadekit/commit/82b7d03ee72416c7fd9ca90ec1bc6184f4724cf4), [`db8014a`](https://github.com/lucasthevenet/arcadekit/commit/db8014a316aadd221e4f9ebddf030b69dbd4f80d), [`7bfc4b6`](https://github.com/lucasthevenet/arcadekit/commit/7bfc4b61a928e52884212a8f23fcad1fa48cd623)]:
  - arcadekit@0.8.0
