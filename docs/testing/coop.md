# Testing a Co-op game

`arcadekit/net/testing` runs a Co-op client in Node, with no browser: `FakeCoopRooms.make()` is a signalling worker and WebRTC in memory (with `FakeCoopRooms.drop(hub, peer)` and `FakeCoopRooms.closeHost(hub)` to cut links) and `ManualTicker.make()` a ticker the test drives (`ManualTicker.tick(timer)`), each with a `layer` a `Coop`'s layer takes. `PageTimers.layer` has an Effect run on the timers a test fakes ([below](#on-fake-timers)). Frames come from `ManualFrames.make()` in [`arcadekit/game/testing`](engines.md), provided as `Game.Frames`. It also has a small game to run: `TestGame.TestGame`, a declared simulation with lobby picks, an offer each player answers with a command the rules may refuse (`TestGame.AnswerOffer`, `TestGame.NothingOwed`), a pause a player holds with another (`TestGame.HoldPause`) and an end (`TestGame.RunEnded`), with its content (`TestGame.content`) and its state hash (`TestGame.hash`). Content with `offerAtStart: true` starts the run on an offer that its `create` reports: a start that reports, for a test of what a seat hears first. It has no Co-op client of its own: a test makes one as an app does, from a `Coop`'s `layer`, its own game's or one declared over `TestGame.TestGame`.

```ts
import * as Game from "arcadekit/game/browser";
import { ManualFrames } from "arcadekit/game/testing";
import { Coop } from "arcadekit/net/browser";
import { FakeCoopRooms, ManualTicker, TestGame } from "arcadekit/net/testing";
import { Context, Effect, Layer } from "effect";

// A Coop to test: the kit's test game, drawn nowhere.
class TestEngine extends Game.Engine("TestEngine", {
  simulation: TestGame.TestGame,
  view: () => ({ render: () => {}, dispose: () => {} }),
  input: () => ({
    read: () => ({ players: [{ add: 1 }], leaving: [] }),
    dispose: () => {},
  }),
}) {}

class TestCoop extends Coop("TestCoop", {
  engine: TestEngine,
  input: () => ({ read: () => ({ add: 1 }), dispose: () => {} }),
  content: Effect.succeed(TestGame.content),
  picks: (content) => content.picks,
  config: (content, picks) => ({ content, picks }),
  hash: TestGame.hash,
  ends: [TestGame.RunEnded],
}) {}

const hub = FakeCoopRooms.make();
const timer = ManualTicker.make();

// One player's client: the Coop's layer over the fake rooms, the manual ticker and manual frames.
const player = Layer.build(
  TestCoop.layer.pipe(
    Layer.provide(FakeCoopRooms.layer(hub)),
    Layer.provide(ManualTicker.layer(timer)),
    Layer.provide(Layer.succeed(Game.Frames, ManualFrames.make()))
  )
).pipe(Effect.map((context) => Context.get(context, TestCoop)));

// The scope owns both clients, and closing it leaves: the whole test runs inside it.
const twoPlayers = Effect.gen(function* () {
  const host = yield* player;
  const guest = yield* player;
  yield* host.listen((event) => console.log("host", event._tag));
  // `host` and `join` return at once: give each a moment to do its work.
  yield* host.host("red");
  yield* Effect.sleep("10 millis");
  yield* guest.join(hub.code, "green");
  yield* Effect.sleep("10 millis");
  yield* host.start;
  // A tick runs the steps the Clock says are due, so let time pass between ticks.
  for (let tick = 0; tick < 50; tick++) {
    yield* Effect.sleep("4 millis");
    ManualTicker.tick(timer);
  }
  // About 12 steps in those 200 ms, and both players' lobby picks: [ 'red', 'green' ].
  console.log(host.debug().stepIndex, guest.debug().state?.picks);
}).pipe(Effect.scoped);

Effect.runFork(twoPlayers);
```

## On fake timers

The example above waits on real time. A test on fake timers provides `PageTimers.layer` to each of its Effects, so that advancing the timers moves a run's ticker and its clock together.

In Node, Effect reads its time from `process.hrtime` and runs its fibers on `setImmediate`, and a test's fake timers reach neither: a run's clock would stand still while its ticker's faked timer ran on, and a fiber would go on at a real moment the test doesn't await. `PageTimers.layer` gives the Effect a `Clock` on the page's timers (`performance.now()` for the time a run steps by, `setTimeout` for a sleep) and a scheduler that runs its fibers on microtasks, as Foldkit's does in the browser. Nothing else of the Effect changes: what it gives, fails with and needs.

```ts
import { PageTimers } from "arcadekit/net/testing";
import { Effect, Scope } from "effect";

// The test's scope, which owns its clients. A test file makes it in `beforeEach`, after faking
// the timers, and closes it in `afterEach`, before restoring them. With Vitest:
//   vi.useFakeTimers({
//     toFake: ["setInterval", "clearInterval", "setTimeout", "performance"],
//   });
const scope = Effect.runSync(Scope.make());

/** Runs `effect` as the app does: in the app's scope, on the timers the test fakes. */
export const run = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Scope.provide(scope), Effect.provide(PageTimers.layer))
  );

// With `player` as above, built without `ManualTicker.layer(timer)`, a run ticks on the default ticker: in
// Node, the faked `setInterval`. A test then reads:
//   const host = await run(player);
//   const guest = await run(player);
//   await run(host.host("red"));
//   await vi.advanceTimersByTimeAsync(0); // lets what woke run, at the faked time
//   await run(guest.join(hub.code, "green"));
//   await vi.advanceTimersByTimeAsync(0); // a lobby needs its second player to start
//   await run(host.start);
//   await vi.advanceTimersByTimeAsync(5000); // five seconds of the run
```

- **Wrap every Effect the test runs or forks**, the one that builds the client's layer first: a client takes its Clock and its scheduler from the Effect that made it, and what it forks later runs on them.
- **It fakes nothing itself**, and imports no test runner: it reads the globals as they are when the Effect runs. Fake `performance` and `setTimeout`, and `setInterval` with `clearInterval` for a run on the default ticker, which ticks on the page's timer where no worker starts, as in Node. Leave `queueMicrotask` real.
- **With `ManualTicker`** the test ticks, and the faked time is still the run's: move the time, then tick.
