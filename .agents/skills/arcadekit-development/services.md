# Services, resources and layers

How a new service of the package is shaped. What the ones it has do is in their doc comments and their guides.

- **A service is a class that extends `Context.Service`**, with its interface as the second type parameter. Give it a static `layer` when there is one obvious implementation.
- **Which kind a new one is** follows from what it stands for:

| It stands for | It is | As |
| --- | --- | --- |
| What every platform has some form of | A `Context.Reference` whose default works everywhere, and holds nothing, so that sharing it is safe | `Driver.Display` |
| What only some programs have | A `Context.Reference` whose default is to have none, so that the systems that would use it do nothing at all | `Input.Source`, `View.Bridge`, `Sound.Output` |
| What a program cannot do without, and has no default | A `Context.Service` with plain calls that do not wait, so that the tick that uses them stays one synchronous step | `Transport` |
| What a platform hosts | A handler of plain functions that keep nothing between two calls and give back what to do as a value. What binds it to one platform is an example or a package of its own | `Relay.join`, `Relay.forward` |

- **A service that listens holds how to open what listens, not the open thing**, as `Transport` does: its layer opens nothing, and `Transport.connect` opens the socket in the caller's scope, so where the layer is provided does not decide how long the socket lasts, and a program with no scope does not compile. What is used after its scope has closed says so. `Browser.layer` still opens its listeners when the layer is built, and is gone with the line it is provided to.
- **A new service comes with what a test works it by**, as `Driver.makeManualDisplay`, `Input.makeManualSource` and `Transport.makeHub` are.
- **Do not build a layer by hand** with `Layer.build`. `App.make` is the one place that does.
- **`Effect.runSync` and `Effect.runPromise` are for tests and benchmarks.** Inside a program, an Effect is yielded, never run.

```ts sketch
export class Audio extends Context.Service<
  Audio,
  { readonly play: (cue: string) => Effect.Effect<void> }
>()("arcadekit/Audio") {
  static readonly layer = Layer.succeed(Audio, {
    play: (cue) => Effect.log(`play ${cue}`),
  });
}
```

References: [Managing Services](https://effect.website/docs/v4/requirements-management/services), [Managing Layers](https://effect.website/docs/v4/requirements-management/layers), [Layer Memoization](https://effect.website/docs/v4/requirements-management/layer-memoization), [Scope](https://effect.website/docs/v4/resource-management/scope); examples for [a service](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/03_services/01_service.ts), [Context.Reference](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/03_services/10_reference.ts), [composing layers](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/03_services/20_layer-composition.ts) and [acquireRelease](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/05_resources/10_acquire-release.ts); API for [Context](https://effect.website/docs/v4/api/effect/Context) and [Layer](https://effect.website/docs/v4/api/effect/Layer).
