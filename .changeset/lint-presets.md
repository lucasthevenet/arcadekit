---
"arcadekit": minor
"@arcadekit/three": minor
---

The repository lints with Ultracite's Oxlint presets and the anti-slop rules. The packages' code follows them: no `any`, a SAFETY comment on each cast that remains, services named after what they are, and values typed where they were `unknown` or `any`.

**Breaking**

- The services' interfaces carry the service's name, not `Shape`: `View.PortShape` is `View.Port`, `Transport.Shape` is `Transport.Transport`, `Input.SourceShape` is `Input.Source`, `Sound.OutputShape` is `Sound.Output`, `Sound.PlayerShape` is `Sound.Player`, `Assets.LoaderShape` is `Assets.Loader`, `Assets.StoreShape` is `Assets.Store`, `Driver.DisplayShape` is `Driver.Display`, and `Three.SceneShape` and `Three.RendererShape` are `Three.Scene` and `Three.Renderer`.
- `Assets.Status` is a tagged enum: a status is made with `Assets.Status.Ready({ assets })`, `Assets.Status.Failed({ error })`, `Assets.Status.Absent()` and `Assets.Status.Loading()`, and compared by its fields.
- What held `any` holds `unknown`, and is narrowed before use: `Plugin.AnySystem` is `System<unknown, unknown>`, `Plugin.Any` is a plugin of unknowns, `Plugin.AnyHandler` is an interface of what every handler has, `System.Touched` takes any `Event.AnyEventDef`, a component of unknown schema reads as a record of unknowns, and `Three.ColorComponent`'s fields are `FieldDef<number, unknown>`.
- `Migrate.mapField` hands its map the old value as `unknown`: `(hp) => Number(hp) / 2`. `Migrate.addField` and `Migrate.mapField` throw a `TypeError` for a value a number field cannot hold, where they stored `NaN`.
- Reading a state whose world holds a value the state no longer has throws, saying how to migrate the save.
- A glTF file whose JSON is not a glTF document fails its bundle.
- `ComponentDef.of` and `RefCodec`'s `encode` and `decode` are declared as methods.
- `Actions.handles` takes any object with a `name`. `View.Sent` holds the action's name and how to issue it, not its payload. `Sound.Line` holds its event's reader, and its `pick` takes `never`.
- `Browser.layer`'s `gamepads` option returns an `Iterable`. `Browser.AudioLike`'s nodes are `Browser.AudioNodeLike`, its methods return `void` or `Promise<void>`, and `createMediaElementSource` takes a `Browser.MediaLike`, whose `play` returns `Promise<void>`.
