---
status: accepted
---

# The kit owns co-op from the signalling worker to the client; the screens stay in the app

> Since [ADR-0020](0020-a-game-is-declared.md): a Co-op game's `simulation` is its declared `Game.Simulation` class, which the lockstep run steps through `Game.Loop`. The players' step input is `arcadekit/game`'s `PlayerInputs`, which the simulation declares with `Game.PlayerInputs(OnePlayersInput)`; `soloInput` is there too. The lockstep session takes the one-player Schema and the combining from that declaration, so `CoopRules` has no `codec` and no game passes `combinePlayerInputs`. The rest of this decision stands until the Co-op client has its own declaration.

[ADR-0012](0012-delay-based-lockstep-over-a-host-star.md) put the lockstep session, its transports and the signalling protocol in the kit. Everything around them stayed in the survivors demo: the signalling worker, the lobby and its messages, the content hash, the worker-timed ticker, the frame loop that draws a run, and the client that ties them together (917 lines, with about as many of tests). A second game on the kit, grimbonk, needed all of it and copied it. The two copies then drifted: grimbonk's client validates lobby picks, takes its input from the game and sends four kinds of answer; the demo's did none of that. ADR-0012 already called the demo's `CoopClient` the home of this code "for now".

Two games use the same code, which is what [ADR-0001](0001-kit-changes-need-two-genres.md) asks for before the kit takes something in.

## Decision

**The kit owns co-op, in three modules.** The worker and the client were the demo's code. The step input was each genre's own, survivors' and grimbonk's.

- **The signalling worker** is the entry `arcadekit/net/worker`. An app's Worker extends the room class and exports the `fetch` handler.
- **The players' step input** is `PlayerInputs<PlayerInput>` in `arcadekit/runtime`: each player's input by slot, and the slots leaving. `soloInput` fills it for one player and `combinePlayerInputs` (`arcadekit/net`) from a lockstep session's confirmed steps.
- **The Co-op client** is `makeCoopClient` in `arcadekit/net/browser`. It runs one player's side of a **Co-op game**: it loads the content, opens or joins a room, runs the lobby, starts a lockstep run, ticks it on a worker's timer and on each animation frame, and draws it while attached.

**A game supplies its genre half, in two values.**

- `CoopRules<G>` (`arcadekit/net`) is DOM-free, so a genre keeps it beside its simulation and tests it in Node. It holds what every peer must agree on (`simulation`, `codec`, `hash`, `picks`, `config`, `maxPlayers`, `lockstep`) and what the local player's seat needs (`localInput`, `settled`, `choosing`, `localEvent`, `runEnded`). `G` is a `CoopTypes` bag of seven types the game declares once.
- `CoopGame<G, LoadError>` (`arcadekit/net/browser`) adds `content`, an Effect run once per host or join, and `presentation`, an Effect run once per attach that gives `createInput` and `createView`.

**The client's interface is commands and one stream of events.** `host`, `join`, `choose`, `start`, `answer` and `setPaused` return at once. `leave` returns once the seat has closed. `listen` reports a seat in order: `lobby` events, one `started`, then `run` and `waiting` events, then at most one `failed`, which is its last. Only `attach` has a typed failure. Its `attach` and `listen` have the shapes of `arcadekit/foldkit`'s `AttachableEngine`, which `net` may not import, so an app hands the client to `engineEntry` as it is.

**The lobby is the kit's; its screens are the app's.** The lobby's messages and state are plain values behind the client, in `arcadekit/net`'s folder but not in its interface: an app reads the `lobby` event and calls nothing else. What a player chooses there is a **lobby pick**: a string id from the game's `picks(content)`, such as a hero. At the start the host replaces an empty or unknown pick with the first, and a guest that receives a pick its own content lacks refuses the start. The `lobby` event carries the players with their names and picks, the game's `maxPlayers` and `canStart`, so an app's view only reads it. The Foldkit glue (Model, Messages, Commands, the Subscription) stays in each app.

**The kit knows one answer.** `answer(value)` is the one thing a player tells a run besides its device's input. The client holds it on every step's input until the game's `settled` says it can no longer apply. Survivors' upgrade pick is one case; grimbonk's pick, reroll, skip and banish are four values of one type. `choosing` says who still owes an answer, for the `waiting` event.

**The kit combines the players' inputs.** A Co-op game's simulation takes `PlayerInputs<PlayerInput>` as its step input, and the client passes `combinePlayerInputs` to the session. `CoopRules` has no `combine` member and the type bag no `Input`.

**The view reads a live local player.** `createView` gets a `LocalPlayer` whose `slot` and `names` follow the current seat, and reads it when it renders. The client never makes a view again. Survivors' views now take the local hero's slot as a function for this.

**Test helpers are an entry.** `arcadekit/net/testing` has `fakeCoopRooms` (the signalling worker and WebRTC in memory), `manualTicker` and `testCoopGame` (a small game with lobby picks, an offer to answer, a pause and an end). The kit tests its client against that game. A game tests its own half, and its app keeps one two-browser check.

**Behaviour is ADR-0012's.** No late join, the drop rule, the host star, a tick every 4 ms, "waiting" shown after 300 ms, and the last 32 hashes kept for `debug`. Input delay and the hash interval default to 4 and 60 steps; a game can state its own in `CoopRules.lockstep`, since every peer must use the same.

## Considered Options

Three designs for the client's interface were written out and compared. The decision is a hybrid on the second.

- **The smallest interface.** One game value of nine members and four type parameters, and a client with one `send(command)` beside `attach`, `listen` and `debug`. The kit would own everything it could. Rejected in this shape: `send` is seven command shapes behind one name, so a caller learns as much as with seven methods. It passed the run's events on unfiltered, which moves "is this my offer" into each app's `update`. It bundled the view and the input behind one `present` call, so a view that throws after its input was made would leak the input unless every game handled it. Kept from it: the live local player, `debug().state` in place of a hook, and leaving on a failed attach behind the seam.
- **Grimbonk's client, lifted as it is** (the base). DOM-free rules, a browser presentation, content loaded per seat, a method-shaped client with one ordered event stream, and explicit `localEvent` and `runEnded`. Its seam sits where lockstep already has one. As written it had twelve type parameters, two optional predicates with two code paths each, a `debug` hook, a prepare step with its own error type, and helper exports such as `canStart` that every app's view would call again. The decision cuts those: one type bag, `settled` and `choosing` required, the presentation as one Effect per attach, and `canStart` on the event.
- **An engine seam.** Make "local player" a concept of `arcadekit/runtime`, so the solo engine and the Co-op client share one run shape, and a game has one presentation for both. Rejected for now: it changes `GamePresentation` and `GameView` for every solo game to serve one caller, touches four entries in one change, and splits the events into two streams, which loses the order between `started` and the first run event. ADR-0001 says a change to the engine's contract gets its own issue. Kept from it: the type bag, the per-attach presentation Effect, and a lobby event that carries names, the limit and `canStart`.

Smaller choices:

- **A `combine` member on the rules.** Each game would pass its own function from confirmed steps to its step input. Both games' functions were the same twenty lines over the same shape, so the kit took the shape (`PlayerInputs`) and the function.
- **A seam under the signalling worker, with a Cloudflare adapter.** Rejected: there is one host, and nothing to vary. The worker's rules are already plain values behind an Effect shell, so a second host would start from them. Until one exists, `arcadekit/net/worker` imports `cloudflare:workers` directly and is the only entry that may.
- **An offer number captured when the player answers,** so the kit could tell a settled answer itself. Rejected: survivors numbers offers per run and grimbonk per hero, and a click on a stale card would behave differently from today. The game's `settled` keeps each game's rule exactly.
- **Rebuild the view when the slot is known.** The demo's client did. A rebuild can block the main thread long enough for the host to drop the player, so the view reads the slot live instead.
- **Lobby screens in the kit.** Rejected: the kit has no UI of its own, and the two games' lobbies look nothing alike.

## Deferred

- **The engine seam.** Single-player and co-op stay two paths in each game: `makeSurvivorsGame` and `makeSurvivorsCoopGame` both build the genre's views. One run shape for both is its own issue, now that the client is small enough to show what is left.
- **Foldkit glue in the kit.** Each app writes its own Commands, Messages and Subscription over the client. Two apps is the evidence so far, and their screens differ; a shared module waits until the copies show its shape.
- **Shared end-to-end helpers.** Each app's two-browser check starts its own dev server and reads its own DEV global, which maps `debug()` to plain numbers its pages can return. The helpers stay in the apps. Two apps carry near copies, and so do the forty lines that give a client test a `Clock` on the faked time and a microtask scheduler. Both are recorded as findings in [co-op-findings.md](../co-op-findings.md).

## Consequences

- **The demo's `src/coop/` is one file,** the worker's URL and the STUN servers. The kit reads no environment: an app passes both to `browserCoopRooms`.
- **The kit owns English text.** Player names ("Host", "Guest 2") and failure messages are the kit's. A `failed` event carries a `reason` tag (`content`, `room`, `leftOut`, `unknownPick`, `tooManyPlayers`, `hostLost`, `desync`, `contentMismatch`, `removed`, `badInput`, `bug`), so an app can show its own words. Names have no such tag: an app's lobby can rename players from their ids, but the names a run's events carry are the kit's.
- **Content must be JSON data.** The client hashes it to compare peers, so it must survive `JSON.stringify`, and the hash is sensitive to key order.
- **The lobby's messages changed on the wire.** They are `pick`, `lobby` (players with `pick`) and `start` (players, picks); the demo's said `hero` and `heroIds`. Peers on different builds can't share a lobby, which the content hash already implied for a run. A `start` lists up to `MAX_ROOM_SIZE` (16) players, since a worker's room size can be that large; the game's `maxPlayers` is the limit that counts.
- **The game's `maxPlayers` bounds a run on both sides.** The demo's room size was its limit. Now a room can hold more than the game takes, so the host plans the run for the first `maxPlayers` players in lobby order: a guest that links between the host's start and the worker's word is left out, and fails with `leftOut`. A guest refuses a start with more players than its own game takes. Only a host on another build sends one, and it fails with `tooManyPlayers`. It has a tag of its own, apart from `unknownPick`, because an app re-words `unknownPick` in its game's terms (a hero the player's game doesn't have), which would be wrong here.
- **The survivors demo's guest now refuses an unknown lobby pick.** It checked nothing before, and its host replaced only empty picks. A guest whose content lacks a hero the host started with fails with `unknownPick` and leaves the room; the host's run goes on without them.
- **A new seat waits for every seat before it.** `host` and `join` close the earlier seats fully before the new one's first event, its failure included, and `leave` returns once they have all closed. The demo's client let the new lobby speak first.
- **Commands outside their phase do nothing.** `answer` and `setPaused` before the run are dropped, and so is `choose` once it has started. The demo's client held a pause set in the lobby, so the run froze from its first step. It also reported one empty `waiting` event after a run's first tick; the kit's reports `waiting` only when who it waits on, or who is choosing, changes.
- **The client poses as an engine by shape only.** A drift between its `attach` and `listen` and `AttachableEngine` shows in an app's typecheck, not in the kit's.
- **Run events gain a level.** An app's `update` reads `{ type: "run", event }`.
- **Eighteen entries.** `arcadekit/net/worker` and `arcadekit/net/testing` are in the `net` group, which lint checks as one, so neither adds an arrow ([ADR-0018](0018-one-package-with-entries.md)).
- **ADR-0012 and ADR-0013 keep their wording.** Where they place the worker in the demo, name the demo's `CoopClient`, or name survivors' `combineHeroInputs` and `soloInput`, read the kit's.
- **Grimbonk moves after the release.** Its client is the second copy this design was checked against; it becomes a Co-op game once this is published.
