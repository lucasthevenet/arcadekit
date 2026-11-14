# A Co-op game

A game for several players, each in their own browser, is declared with **`Coop`** (`arcadekit/net/browser`): the game's [engine](engine.md), played in lockstep from a lobby. The class is the key of the **Co-op client** an app drives, one player's side of it: the lobby over the signalling worker and WebRTC, then a lockstep run stepped on a worker's timer (so a hidden tab keeps up), drawn on animation frames while attached. The lobby's screens stay in the app.

```ts
import * as Game from "arcadekit/game/browser";
import { Coop, CoopRooms } from "arcadekit/net/browser";
import { Effect, Schema } from "effect";

interface Palette {
  readonly colours: readonly string[];
}

interface Tally {
  readonly colours: readonly string[];
  total: number;
}

// More than a player may add at once.
class TooMuch extends Game.Rejection("TooMuch", { most: Schema.Int }) {}

// What a player decides: to add `amount` at once.
class AddNow extends Game.Command(
  "AddNow",
  { amount: Schema.Int },
  { rejects: [TooMuch] }
) {}

// The player at slot `by` added `amount` at once.
class Added extends Game.Event("Added", {
  by: Schema.Int,
  amount: Schema.Int,
}) {}

// The total reached a hundred: the run is over.
class Filled extends Game.Event("Filled", { total: Schema.Int }) {}

// The rules: every player adds a number each step, and may add more with a command.
class Sum extends Game.Simulation("Sum", {
  input: Game.PlayerInputs(Schema.Int),
  events: [Added, Filled],
  commands: [AddNow],
  create: ({ colours }: Palette): Tally => ({ colours, total: 0 }),
  step: (state, input, { report }) => {
    if (state.total >= 100) {
      return;
    }
    for (const add of input.players) {
      state.total += add ?? 0;
    }
    if (state.total >= 100) {
      report(new Filled({ total: state.total }));
    }
  },
  apply: {
    AddNow: (state, { amount }, { player, report }) => {
      if (amount > 10) {
        return new TooMuch({ most: 10 });
      }
      state.total += amount;
      report(new Added({ by: player, amount }));
    },
  },
}) {}

// One player's input source, as a game writes it once: this one adds 1 each step.
const sumDevice = (): Game.InputSource<number> => ({
  read: () => 1,
  dispose: () => {},
});

// The game in the browser. Its view is told which seat is the local player's, and reads it when
// it draws: slot 0 under the engine, the slot the lobby gave under a Coop.
class SumEngine extends Game.Engine("SumEngine", {
  simulation: Sum,
  view: (container, _uses, { local }) => ({
    render: (state) => {
      container.textContent =
        state === null
          ? "No run"
          : `${state.colours[local.slot]}: ${state.total}`;
    },
    dispose: () => {},
  }),
  // The engine's input is the whole step's: for one player, that player's source at slot 0.
  input: () => {
    const device = sumDevice();
    return { ...Game.soloInput(device), dispose: device.dispose };
  },
}) {}

// The same game for several players.
class SumCoop extends Coop("SumCoop", {
  engine: SumEngine,
  // One player's input source, the same one: what it reads rides each step this player
  // schedules.
  input: sumDevice,
  content: Effect.succeed({ colours: ["red", "blue"] }),
  picks: (content) => content.colours,
  config: (_content, colours) => ({ colours }),
  hash: (state) => state.total,
  ends: [Filled],
}) {}

const play = Effect.gen(function* () {
  const coop = yield* SumCoop;
  // Everything a seat reports, by tag: the client's own events, and the run's under `run`,
  // each with the local player.
  yield* coop.listen(
    SumCoop.match({
      LobbyChanged: ({ code, players, canStart }) =>
        console.log(code, players, canStart),
      RunStarted: ({ slot, names }) => console.log(`You are ${names[slot]}`),
      WaitingChanged: ({ waitingFor }) =>
        console.log("Waiting for", waitingFor),
      SeatFailed: ({ reason, message }) => console.error(reason, message),
      run: {
        Added: ({ by, amount }, { local }) =>
          console.log(
            by === local.slot ? "You" : local.names[by],
            `added ${amount}`
          ),
        Filled: ({ total }) => console.log(`Done at ${total}`),
      },
    })
  );
  yield* coop.host("red");
  // The app calls `coop.start` once the lobby's `canStart` is true. In the run, a click adds
  // five at once: every peer's rules take the command at one step, and this player hears.
  const addNow = coop.send(new AddNow({ amount: 5 })).pipe(
    Effect.catchTag("TooMuch", ({ most }) => Effect.log(`At most ${most}`)),
    Effect.catchTag("CommandDropped", () => Effect.void)
  );
  document.body.addEventListener("click", () => Effect.runFork(addNow));
  return yield* coop.attach(document.body);
}).pipe(
  Effect.scoped,
  Effect.provide(SumCoop.layer),
  // The app's rooms: the signalling worker and its STUN servers.
  Effect.provide(
    CoopRooms.layer(() => ({
      url: "wss://signalling.example.com",
      iceServers: [{ urls: "stun:stun.example.com:3478" }],
    }))
  )
);

Effect.runFork(play);
```

What the declaration holds, every type of it taken from the engine's simulation and from `content`:

- **`engine`** is the game: its simulation, what its view is made from (`uses`) and the view. Both hosts play it. The engine seats its one player at slot 0, and the Co-op client at the slot the lobby gave: the view's third argument is `{ local }`, read when it draws, so the client never makes a view again. The simulation's `input` is a [`Game.PlayerInputs`](several-players.md).
- **`input`** makes one player's input source, where the engine's `input` reads the whole step's. The word is shared on purpose: they are one source, and the engine's is `Game.soloInput` of this one, which puts it at slot 0. It is made on each attach, after the view, with what the engine uses, so a view and an input can share what one attach made. With nothing attached, the player's input is null for each step, which the rules see at its slot.
- **`content`** loads what a run is played with, once per seat: a [`Content`](content.md) declaration's `load`. Every peer loads its own, and the client compares their hashes, so it is JSON data. **`picks`** lists the valid lobby picks, string ids such as heroes, and **`config`** makes the run's config from the content and the players' picks, by slot.
- **`hash`** digests the whole state: peers compare it every `lockstep.hashEvery` steps (60), and a mismatch stops the run as a desync. **`maxPlayers`** is the most players a run takes (a room's 4 unless it says), and `lockstep.inputDelay` the steps ahead input is scheduled (4).
- **`ends`** lists the events that end a run, of those the simulation reports. After one, the others leaving is no failure: the seat stops quietly, with the run's end still on screen.

A `Coop` refuses what can't work when it is declared: an engine whose simulation's `input` was not declared with `Game.PlayerInputs` is a type error on `engine` that names it, and a throw as the module loads for what a cast gets past; so is an `ends` entry the simulation doesn't report (its sample included, which a run reports all the time), and a `maxPlayers` no room can have (a room holds 2 to 16).

`SumCoop.layer` provides the client. It needs what the engine uses, what `content` needs, and the app's rooms:

- **`CoopRooms.CoopRooms`** is the service a lobby is opened through. `CoopRooms.layer(() => ({ url, iceServers }))` provides the browser's, over the signalling worker and WebRTC; the kit reads no environment, so the app says the worker's URL and its STUN servers, in a function the layer calls when it is built. `FakeCoopRooms.layer(hub)` provides a test's.
- **`CoopTicker.CoopTicker`** is what ticks a run: a reference, whose default is a timer in a dedicated worker, made and stopped with each run. A test provides `ManualTicker.layer(timer)`.
- **`Game.Frames`** is the frame clock while attached, as for an engine.

The client's commands return at once, except `leave`, which returns once the seat has closed. One stream of events says what happened:

- `host(pick)`, `join(code, pick)` and `leave` choose the **seat**: this player's place in one room, from its host or join on. A new seat says nothing until every seat before it has closed. A **lobby pick** is a string id the game lists in `picks(content)`. `choose(pick)` changes it, and `start` starts the run if the lobby's `canStart` is true: at least two players, at most the game's `maxPlayers`, each with a pick. At the start the host replaces a pick its game doesn't have with the first, and leaves out a guest that linked too late to fit in `maxPlayers` (it fails with `leftOut`). A guest whose game doesn't have one of the picks fails with `unknownPick`, and one whose game takes fewer players fails with `tooManyPlayers`.
- `send(command)` is how a player tells the run anything besides its device's input: an upgrade pick, a pause it holds for everyone. It is an engine's `send` in shape and in type. The command [rides the player's next step](lockstep-sessions.md#commands), every peer's rules take or refuse it alike at that step, and the Effect succeeds when the local player's own took it, fails with the rejection they refused it with, and fails with `CommandDropped` when they gave no answer: there is no run yet (`noRun`), or the run stopped or the player left first (`runEnded`). It completes after the seat's listener (`listen`) has been called with what the command's step reported, so a Command that listens and then sends knows what its command's step did: whether a pick opened another offer for the local player, say. The kit knows nothing of pausing: a game that has a pause declares a command for it, and its app keeps the screen.
- `listen` reports a seat in order: `LobbyChanged` events (who is in the lobby, and whether it can start), one `RunStarted` (the local player's slot, and every player's name), then the run's own events and `WaitingChanged` (who stepping waits on, once the run has stood at one step for 300 ms; a run that steps waits on nobody, however far behind another peer's it is), then at most one `SeatFailed`, which is its last: it has the kit's `message` and a `reason` tag an app can re-word. The four are Schema classes, so an app puts one in a Message or its Model as it is. A seat hears its run from the start, the host's as a guest's: what the simulation's `create` reports (a first stage's banner, say) comes right after `RunStarted`, then the run's first sample, each once.
- **`SumCoop.match({ ... })`** turns all of it into one value, as a simulation's `match` does for an engine: a case for each of the client's events by its tag, and under `run` a case for each of the run's events and its sample, which gets `{ local }` beside the event: the local player of the seat that heard it, which stays that seat's if the event is kept. A run's events reach every seat as the rules reported them, so the app says which are the local player's: `hero === local.slot`. The run's cases have their own place, so a game may name an event as it likes. A missing case is a type error, and a case for an event that doesn't exist (one a renamed event left behind, or a run's case written beside the client's own) is refused when `match` is called, as the app's module loads, with a message that says where it goes.
- **Who a run waits on to decide** something, such as an upgrade to pick, is the game's to say: its sample does, as survivors' HUD has a `choosing` flag for each hero, and the app names the players from it. The client reports only who stepping waits on.
- `attach(element)` draws and reads input until interrupted, as an engine's does: it runs what the engine uses, makes the view, then the input source. `attach` and `listen` have the shapes of `arcadekit/foldkit`'s `EngineEntry.Attachable`, so `EngineEntry.make({ engine: SumCoop, toMessage: SumCoop.match({ ... }), ... })` mounts co-op as it mounts an engine. A failed attach leaves the seat; a detach doesn't.

What every peer of a run must agree on is on the class as plain values and functions, `SumCoop.definition.hash`, `picks`, `config`, `maxPlayers` and `lockstep`, so a test reads them in Node, and the rules themselves are the engine's simulation, checked with [scenarios](../testing/scenarios.md). [Testing a Co-op game](../testing/coop.md) runs whole clients.
