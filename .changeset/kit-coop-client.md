---
"arcadekit": minor
---

The kit owns the Co-op client: one player's side of a co-op game, from the lobby to the run. It was the survivors demo's own code, which every game with co-op had to copy. A game now supplies its genre half, and its app keeps the lobby screens (ADR-0019).

```ts
import { browserCoopRooms, makeCoopClient } from "arcadekit/net/browser";

const play = Effect.gen(function* () {
  const coop = yield* makeCoopClient(myCoopGame, {
    rooms: browserCoopRooms({ url: "wss://game.example.com", iceServers }),
  });
  yield* coop.listen((event) => {
    // lobby, started, run, waiting, failed
  });
  yield* coop.host("knight");
  return yield* coop.attach(element);
}).pipe(Effect.scoped);
```

**`arcadekit/net`** (DOM-free) gains a Co-op game's lockstep parts:

- `CoopRules<G>` and the `CoopTypes` bag `G` a game declares once (`Config`, `State`, `Event`, `PlayerInput`, `Answer`, `LocalEvent`, `Content`). The rules hold the `simulation`, whose step input is `PlayerInputs<PlayerInput>`, with `codec`, `hash`, `picks`, `config`, the optional `maxPlayers` and `lockstep: { inputDelay, hashEvery }` (defaults `DEFAULT_ROOM_SIZE`, 4 and 60), and what the local player's seat needs: `localInput`, `settled`, `choosing`, `localEvent` and `runEnded`. The client combines the players' inputs with `combinePlayerInputs`, so the rules have no `combine`.
- The lobby as plain values: the `LobbyMessage` and `LobbyPick` types, `encodeLobbyMessage`, `parseLobbyMessage` (decoded with Schema), `withPlayer`, `withoutPlayer`, `withPick`, `canStart`, `startPlan`, `knownPicks` and `playerName`.
- `contentHash(content)`: the hash peers compare at the start. Content must be JSON data, and the hash is sensitive to key order.

**`arcadekit/net/browser`** gains the client:

- `makeCoopClient(game, { rooms, ticker?, frames? })`, a scoped Effect, and its `CoopClient`: `host(pick)`, `join(code, pick)`, `choose(pick)`, `start`, `answer(answer)`, `setPaused(paused)`, `leave`, `attach(element)`, `listen(onEvent)` and `debug()`. The commands return at once. `attach` and `listen` have the shapes of `arcadekit/foldkit`'s `AttachableEngine`, so `engineEntry` takes the client as it is. `attach` fails with `AttachError`, `GameCrashed` or the game's `LoadError`, and a failed attach leaves the seat.
- `CoopGame<G, LoadError>`: the rules plus `content`, an Effect run once per host or join, and `presentation`, an Effect run once per attach that gives a `CoopPresentation` (`createInput`, `createView`). The view gets a live `LocalPlayer` (`slot`, `names`) and reads it when it renders.
- `CoopEvent`: `lobby` (role, code, self, `LobbyPlayer`s, `maxPlayers`, `canStart`), `started` (slot, names), `run` (what the game's `localEvent` makes of a run's event), `waiting` (who stepping waits on, who is choosing) and `failed`, with the kit's English `message` and a `CoopFailure` reason an app can re-word: `content`, `room`, `leftOut`, `unknownPick`, `hostLost`, `desync`, `contentMismatch`, `removed`, `badInput` or `bug`. Player names ("Host", "Guest 2") are the kit's too.
- `CoopRooms` and `browserCoopRooms({ url, iceServers })`. The kit reads no environment: the app passes the signalling worker's URL and its STUN servers.
- `workerTicker({ everyMs })`, with `tickWorker`, `TickWorker` and `WorkerTickerOptions`: a scoped Effect that gives a `Ticker` timed in a dedicated Web Worker, which a hidden tab doesn't throttle. The client makes one for each run unless given a `ticker`.
- `CoopClientOptions` and `CoopDebug` are the types of the client's options and of `debug()`.

**New entry `arcadekit/net/testing`**, for tests only: `fakeCoopRooms()` (the signalling worker and WebRTC in memory, with `drop(peer)`, `closeHost()`, its `code` and a `log`; `FAKE_JOIN_CODE` is the code), `manualTicker()` (a ticker the test drives) and `testCoopGame(options?)`, a small Co-op game with lobby picks, an offer to answer, a pause and an end. Its parts are exported too, so a test can vary the game: `testCoopRules`, `testSimulation`, `testPresentation`, `testContent`, `hashTestState` and the `Test*` types. It needs only `effect`. Frames come from `manualFrames()` in `arcadekit/runtime/testing`.

Behaviour is ADR-0012's, as the demo's client had it: no late join, the drop rule, a host star. Two things are new for a game that used the demo's client as its model:

- At the start the host replaces an empty or unknown lobby pick with the game's first, and a guest that receives a pick its own content lacks fails with `unknownPick` instead of starting.
- The lobby's messages on the wire are `pick`, `lobby` (players with `pick`) and `start` (players, picks). Peers on different builds can't share a lobby.

Per-step and per-frame code is plain, with no Effect: the game's `settled`, `choosing` and the function `localInput` returns run between steps and must not allocate. The package has eighteen entries. `net/testing` is in the `net` group, so it adds no arrow between entries.

Nothing breaks for the existing entries: every change is a new export or a new entry, and no export was removed or changed.
