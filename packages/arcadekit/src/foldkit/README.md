# arcadekit/foldkit

Connects an `arcadekit/runtime` engine to a [Foldkit](https://www.npmjs.com/package/foldkit) app. The view renders `gameViewport`, the element the engine draws into; the Subscription `engineEntry` runs the engine there while it is mounted and turns its events into Messages. `keyPresses` and `shortcutPresses` make Streams of key presses for the app's own keys (pause, restart, mute).

An entry of the [`arcadekit`](../../README.md) package. Needs the DOM.

## Install

```bash
pnpm add arcadekit foldkit effect @effect/platform-browser
```

Peer dependencies: `effect` (~4.1), and `foldkit` (~0.170, an optional peer of the package that this entry needs). Foldkit itself needs `@effect/platform-browser`.

## Example

A whole app around an engine that reports a score: the viewport, its two Messages kept as a Boolean, the engine's events as Messages, and a Command that starts a run (the demo apps do the same with more screens):

```ts
import { engineEntry, gameViewport } from "arcadekit/foldkit";
import type { GameSimulation } from "arcadekit/runtime";
import { makeGameEngine } from "arcadekit/runtime/browser";
import type { GameEngine } from "arcadekit/runtime/browser";
import { Context, Effect, Layer, Schema } from "effect";
import { Command, Runtime, Subscription } from "foldkit";
import type { Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

// The game: its score goes up every step, reported twice a second.
type Event = { readonly type: "score"; readonly score: number };
const simulation: GameSimulation<null, { score: number }, null, Event> = {
  create: () => ({ score: 0 }),
  step: (state) => {
    state.score += 1;
  },
  drainEvents: () => [],
  sample: {
    everyMs: 500,
    read: (state) => ({ type: "score", score: state.score }),
  },
};
class Engine extends Context.Service<
  Engine,
  GameEngine<null, { score: number }, Event>
>()("my-game/Engine") {}
const EngineLayer = Layer.sync(Engine, () =>
  makeGameEngine({
    ...simulation,
    createInput: () => ({ read: () => null, dispose: () => {} }),
    createView: () => ({ render: () => {}, dispose: () => {} }),
  })
);

const Message = defineMessageUnion({
  MountedViewport: {},
  UnmountedViewport: {},
  GotScore: { score: Schema.Number },
  FailedToRun: { error: Schema.String },
  StartedRun: {},
});
type Message = typeof Message.Type;

const Model = Schema.Struct({
  isViewportMounted: Schema.Boolean,
  score: Schema.Number,
});
type Model = typeof Model.Type;

const StartRun = Command.define("StartRun", {
  messages: [Message.StartedRun],
  execute: Effect.gen(function* () {
    yield* (yield* Engine).start(null);
    return Message.StartedRun();
  }),
});

type Return = Update.Return<Model, Message, Engine>;
const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    // Start once the viewport is in the document, so the engine's first events arrive.
    MountedViewport: () => ({
      model: { ...model, isViewportMounted: true },
      commands: [StartRun()],
    }),
    UnmountedViewport: () => ({
      model: { ...model, isViewportMounted: false },
    }),
    GotScore: ({ score }) => ({ model: { ...model, score } }),
    // The engine couldn't draw (no WebGL, say), or the game crashed: tell the player.
    FailedToRun: () => ({ model }),
    StartedRun: () => ({ model }),
  });

const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "My game",
  body: h.div(
    [],
    [
      gameViewport(h, {
        mounted: Message.MountedViewport(),
        unmounted: Message.UnmountedViewport(),
      }),
      h.p([], [`Score: ${model.score}`]),
    ]
  ),
});

const subscriptions = Subscription.make<Model, Message, Engine>()(() => ({
  engine: engineEntry({
    engine: Engine,
    isViewportMounted: (model) => model.isViewportMounted,
    toMessage: (event): Message => Message.GotScore({ score: event.score }),
    onError: (error) => Message.FailedToRun({ error: error.message }),
  }),
}));

Runtime.run(
  Runtime.makeApplication({
    Model,
    init: () => ({ model: { isViewportMounted: false, score: 0 } }),
    update,
    view,
    subscriptions,
    resources: EngineLayer,
    container: document.querySelector("#root")!,
  })
);
```

Style `.viewport` in the app: it needs a size. `onError` turns a failed attach (`AttachError`, such as no WebGL) or a crash while attached (`GameCrashed`, a step or a render that threw) into a Message, sent once; for an engine reached through a load (`engineOf(MyEngine)`) it also gets the load's error. `engineEntry` takes anything with an engine's `attach` and `listen` (`AttachableEngine`), so `arcadekit/net/browser`'s Co-op client goes there as it is. The survivors and push-puzzle demos in the [repository](https://github.com/lucasthevenet/arcadekit#readme) are complete apps.
