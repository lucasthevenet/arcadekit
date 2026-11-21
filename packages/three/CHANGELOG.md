# @arcadekit/three

## 0.1.0

### Minor Changes

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

- [#164](https://github.com/lucasthevenet/arcadekit/pull/164) [`d45e1a7`](https://github.com/lucasthevenet/arcadekit/commit/d45e1a7d264c7a901568ea6f73fbf1adc08bd32a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - No export takes or returns `any`. What stands for any component, singleton, event, state, system, plugin, action or handler says what it is: `ComponentDef`, `SingletonSpec`, `EventDef<unknown>`, `State<string>`, `System<unknown, unknown>`, `Plugin.Any` (of `unknown`s), and the new `Action.AnyActionDef` and `Action.AnyHandler`, whose payload is `never`. `System.GenError` and `System.GenServices` are new: what a generator's effects fail with and need, as `Effect.gen` says it, which `System.make`, `Sound.music` and `View.publish` now return. `Driver.interval` beats on Effect's `Clock`, so a `TestClock` moves it on. The default `Assets.Loader` asks through Effect's `HttpClient`, over `fetch`.

  **Breaking**

  - `Migrate.mapField`'s `map` names the type of the old value: `(hp: number) => hp / 2`, where `(hp) => hp / 2` took it as `any`.
  - A list typed as `Plugin.AnySystem[]` or `Plugin.AnyHandler[]` and given to `App.make` makes the app need `unknown`, where `any` let it run. Type the list with what its systems need, `System.System<never, World | Time>[]`, or pass the systems themselves.
  - `ComponentDef.of`, `EventHandle.emit`, `StateHandle.is` and `StateHandle.set` are typed as methods, so that a component, an event or a state of any type is one of the types above. They work as before; a game that lints with `typescript/unbound-method` is told about one taken off its object.
  - `Sound.cues`, `Three.instances` and `Three.objects` are overloaded functions, with the same two signatures each.
  - `Three.ColorComponent`'s `r`, `g` and `b` are `FieldDef<number, unknown>`.
  - The default `Assets.Loader` resolves a path against the page's `location`, not its `<base href>`, and a file the server refused says `The server answered 404`, without the status text.

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

- [#156](https://github.com/lucasthevenet/arcadekit/pull/156) [`dc1e4bc`](https://github.com/lucasthevenet/arcadekit/commit/dc1e4bc62b6f82d2c136ec92b2129c388cb5a834) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The doc comments of every export are rewritten in plain, present-tense English, so the Reference pages and editor tooltips read the way the rest of the site does, and they no longer recount how the storage core's entity ids used to be laid out. The READMEs drop their link to the site's "Not done yet" page, which is gone: the site describes arcadekit as it is, and what is not built is in the repository's roadmap. Nothing breaks.

- [#161](https://github.com/lucasthevenet/arcadekit/pull/161) [`f76410d`](https://github.com/lucasthevenet/arcadekit/commit/f76410dd5c56b302a5cd55d1b03c394f69cc1e00) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The build writes each source file to a file of its own in `dist/`, `dist/ecs/world.js` for `src/ecs/world.ts`, in place of chunks shared between entries. An entry now loads only the modules it reaches, and imports only the packages they import.

  Nothing breaks: the entries, and what each one gives, are the same.

- [#154](https://github.com/lucasthevenet/arcadekit/pull/154) [`7a2bfe8`](https://github.com/lucasthevenet/arcadekit/commit/7a2bfe881e8d6cc7c762ec594be7b1f6e71a942e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The READMEs are a description and links. What they explained is on [arcadekit.dev](https://arcadekit.dev), in the guides and the concepts, with what is not built yet on a page of its own, and the doc comments of the exports say what the READMEs said of them. Nothing breaks.
- Updated dependencies [[`b820835`](https://github.com/lucasthevenet/arcadekit/commit/b8208350fc401dc5d66b45cf54a22e01b1bf378a), [`ad8256e`](https://github.com/lucasthevenet/arcadekit/commit/ad8256e85dba65688363ecddfaea5964a09571f8), [`dc1e4bc`](https://github.com/lucasthevenet/arcadekit/commit/dc1e4bc62b6f82d2c136ec92b2129c388cb5a834), [`c418a02`](https://github.com/lucasthevenet/arcadekit/commit/c418a024fca9f61a6508b5667db08c21a501e5b7), [`e63ad0c`](https://github.com/lucasthevenet/arcadekit/commit/e63ad0c42e0f6a10290d13b0edd6db7a738ff972), [`9ff1ad3`](https://github.com/lucasthevenet/arcadekit/commit/9ff1ad312300b9f07503b45ba219e8093e4d7336), [`e543b96`](https://github.com/lucasthevenet/arcadekit/commit/e543b96ac36dfffd5cef1c2c4f7bc9f2c56f6d24), [`c35c665`](https://github.com/lucasthevenet/arcadekit/commit/c35c665b4f2b4487c6dc0aa17a00e3ff6396a800), [`b77e120`](https://github.com/lucasthevenet/arcadekit/commit/b77e120da69818ecef6c27a8dec86955a1bc6cd5), [`d45e1a7`](https://github.com/lucasthevenet/arcadekit/commit/d45e1a7d264c7a901568ea6f73fbf1adc08bd32a), [`47d487a`](https://github.com/lucasthevenet/arcadekit/commit/47d487ac5893a67f0b6ced1715857ae2c35e07e4), [`2448aee`](https://github.com/lucasthevenet/arcadekit/commit/2448aeecd8747de487edd4d2653fc8bdf77cda68), [`b5261e7`](https://github.com/lucasthevenet/arcadekit/commit/b5261e7d11b47c1ce8ae7a6c88ff14b23b81f49e), [`c4d06d8`](https://github.com/lucasthevenet/arcadekit/commit/c4d06d8d3130b330fb80e52f67dd94ce3d46a433), [`2f343e9`](https://github.com/lucasthevenet/arcadekit/commit/2f343e9c4d08bac1c0c37f1142e513df56d6c747), [`f76410d`](https://github.com/lucasthevenet/arcadekit/commit/f76410dd5c56b302a5cd55d1b03c394f69cc1e00), [`eb9f830`](https://github.com/lucasthevenet/arcadekit/commit/eb9f8301969182792ee8954cf12aaf0dbe68796c), [`44f02e9`](https://github.com/lucasthevenet/arcadekit/commit/44f02e94ac01f9f7d37a6357d43bc953c9b08cf6), [`0e63aa7`](https://github.com/lucasthevenet/arcadekit/commit/0e63aa7ee3a1d51c8d520a200ecc06002671ad04), [`4297ae0`](https://github.com/lucasthevenet/arcadekit/commit/4297ae0d7deb89133c3ebeb2450c93c1dce6e1a0), [`90dff63`](https://github.com/lucasthevenet/arcadekit/commit/90dff63402aee481447dd1a5e87e232fc751e269), [`728d196`](https://github.com/lucasthevenet/arcadekit/commit/728d1964f8cdafc8e5e13e8dad1c2dfacdf2607f), [`46cb1c5`](https://github.com/lucasthevenet/arcadekit/commit/46cb1c58bbe56eb4b9e8d84004595b018bcd4f6b), [`7a2bfe8`](https://github.com/lucasthevenet/arcadekit/commit/7a2bfe881e8d6cc7c762ec594be7b1f6e71a942e), [`fa3eb1a`](https://github.com/lucasthevenet/arcadekit/commit/fa3eb1a8d7ec23c4ddac0e83905174732db6ff6a), [`c8a0cc1`](https://github.com/lucasthevenet/arcadekit/commit/c8a0cc1ea97571c92279aa4eaaf63acdad2e4141)]:
  - arcadekit@0.8.0
