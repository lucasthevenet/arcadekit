# arcadekit/foldkit

Connects a game's engine ([`Game.Engine`](../game/README.md#in-the-browser)) to a [Foldkit](https://www.npmjs.com/package/foldkit) app. The view renders the viewport with `Viewport.make`: the element the engine draws into, which reports two Messages as it enters and leaves the document. The Subscription entry `EngineEntry.make` runs the engine there while it is in the document, and turns the engine's events into Messages. `KeyPresses.make` and `ShortcutPresses.make` make Streams of the app's own keys as Messages: pause, restart, mute. Each is a namespace, as Effect's modules are.

An entry of the [`arcadekit`](../../README.md) package. Needs the DOM.

## Install

```bash
pnpm add arcadekit foldkit effect @effect/platform-browser
```

Peer dependencies: `effect` (~4.1), and `foldkit` (~0.170, an optional peer of the package that this entry needs). Foldkit itself needs `@effect/platform-browser`.

## Example

A whole app around an engine that reports a score: the viewport, its two Messages kept as a Boolean, the engine's events as Messages, and a Command that starts a run (the demo apps do the same with more screens):

```ts
import { EngineEntry, Viewport } from "arcadekit/foldkit";
import * as Game from "arcadekit/game/browser";
import { Effect, Schema } from "effect";
import { Command, Runtime, Subscription } from "foldkit";
import type { Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

// The game: its score goes up every step, reported twice a second.
class Scored extends Game.Event("Scored", { score: Schema.Number }) {}

class Counting extends Game.Simulation("Counting", {
  input: Schema.Null,
  create: () => ({ score: 0 }),
  step: (state) => {
    state.score += 1;
  },
  sample: {
    event: Scored,
    every: "500 millis",
    read: (state) => ({ score: state.score }),
  },
}) {}

class CountingEngine extends Game.Engine("CountingEngine", {
  simulation: Counting,
  view: () => ({ render: () => {}, dispose: () => {} }),
  input: () => ({ read: () => null, dispose: () => {} }),
}) {}

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
    yield* (yield* CountingEngine).start(null);
    return Message.StartedRun();
  }),
});

type Return = Update.Return<Model, Message, CountingEngine>;
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
      Viewport.make(h, {
        mounted: Message.MountedViewport(),
        unmounted: Message.UnmountedViewport(),
      }),
      h.p([], [`Score: ${model.score}`]),
    ]
  ),
});

const subscriptions = Subscription.make<Model, Message, CountingEngine>()(
  () => ({
    engine: EngineEntry.make({
      // The engine's class is its service's key, so it is the Effect that reaches the engine.
      engine: CountingEngine,
      isViewportMounted: (model) => model.isViewportMounted,
      // The simulation's `match` handles every event by its tag.
      toMessage: Counting.match({
        Scored: ({ score }) => Message.GotScore({ score }),
      }),
      onError: (error) => Message.FailedToRun({ error: error.message }),
    }),
  })
);

Runtime.run(
  Runtime.makeApplication({
    Model,
    init: () => ({ model: { isViewportMounted: false, score: 0 } }),
    update,
    view,
    subscriptions,
    resources: CountingEngine.layer,
    container: document.querySelector("#root")!,
  })
);
```

Style `.viewport` in the app: it needs a size. `onError` turns a failed attach (`AttachError`, such as no WebGL, or what one of the engine's `uses` fails with, such as a sprite sheet that can't be loaded) or a crash while attached (`GameCrashed`, a step or a render that threw) into a Message, sent once; for an engine reached through a load (an `engine` Effect that can fail) it also gets the load's error. `EngineEntry.make` takes anything with an engine's `attach` and `listen` (`EngineEntry.Attachable`), so `arcadekit/net/browser`'s Co-op client goes there as it is. The survivors and push-puzzle demos in the [repository](https://github.com/lucasthevenet/arcadekit#readme) are complete apps.

## The app's own keys

Keys the app answers outside the run's input, each press a Message. `KeyPresses.make` is for keys that mean something on one screen, so its Stream runs while the Model says so; `ShortcutPresses.make` is for a key that works on any screen, such as M to mute, and ignores a press with Ctrl, Cmd or Alt held, or one that goes into a text field. A key is named by its code, the physical key (`"KeyR"`, `"Escape"`), as `arcadekit/input`'s bindings are, and a key held down is one press:

```ts
import { KeyPresses, ShortcutPresses } from "arcadekit/foldkit";
import { Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { defineMessageUnion } from "foldkit/message";

const Message = defineMessageUnion({
  PressedRestart: {},
  PressedBack: {},
  PressedMute: {},
});
type Message = typeof Message.Type;

interface Model {
  readonly isRunning: boolean;
}

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  // R restarts and Escape goes back, during a run.
  runKeys: entry(
    { isRunning: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isRunning: model.isRunning }),
      dependenciesToStream: ({ isRunning }) =>
        isRunning
          ? KeyPresses.make(["KeyR", "Escape"], (code) =>
              code === "KeyR" ? Message.PressedRestart() : Message.PressedBack()
            )
          : Stream.empty,
    }
  ),
  // M mutes on every screen.
  muteKey: Subscription.persistentEntry(
    ShortcutPresses.make(["KeyM"], () => Message.PressedMute())
  ),
}));
```
