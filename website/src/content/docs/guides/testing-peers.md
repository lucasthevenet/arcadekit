---
title: "Testing several peers"
description: "Test a game of several peers in one process, over a network in memory, and check that a rewind runs a tick the same with one app."
---

**Several peers** are tested in one process: each peer's session in the same test, joined by a network in memory that the test steps by hand, so messages arrive late and out of order but a failure repeats. The test compares the peers' worlds once the game has settled. A second check needs no second peer: it runs each tick twice from the same moment, as a session that rewinds does. See [testing](testing.md) for a game of one.

## Connect several peers

```ts sketch
const hub = Transport.makeHub({ delay: { min: 0, max: 4 }, seed: 1 });
const ada =
  yield *
  Transport.connect(adaSession).pipe(
    Effect.provide(Transport.layer(hub.port("ada")))
  );
const grace =
  yield *
  Transport.connect(graceSession).pipe(
    Effect.provide(Transport.layer(hub.port("grace")))
  );
for (let i = 0; i < 600; i++) {
  hub.step();
  yield * ada.tick();
  yield * grace.tick();
}
// No more input: let messages in flight arrive, then let the peer that is behind catch up.
for (let i = 0; i < 30; i++) {
  hub.step();
  yield * ada.tick();
  yield * grace.tick();
}
while (adaApp.time.tick !== graceApp.time.tick) {
  hub.step();
  yield * (adaApp.time.tick < graceApp.time.tick ? ada : grace).tick();
}
const adaWorld = yield * adaApp.read(World);
const graceWorld = yield * graceApp.read(World);
expect(adaWorld.hash()).toBe(graceWorld.hash());
expect(adaApp.actionLog).toEqual(graceApp.actionLog);
```

`Transport.makeHub({ delay, seed })` is an in-memory network. Nothing is lost, and nothing moves until the test calls `hub.step()`. Each message stays in flight for its delay, a number or a range, so messages can overtake each other. The same seed always produces the same network.

`hub.disconnect(peer)` cuts a peer off, as a socket that drops. What is on its way to the peer or from it is lost, and the others are told it left. `hub.reconnect(peer)` brings it back and tells every peer, as a relay does, so the sessions send again what was lost.

Compare peers once the game has settled and both are at the same tick. Stop issuing input, step a while longer, then tick only the peer that is behind. A single-player game that replays the same log with `Replay.verify` ends on the same hash.

## Check that a rewind runs the same

```ts sketch
const test = yield * Session.syncTest(Duel, { seed: 1 });
for (let i = 0; i < 600; i++) {
  yield * test.tick(1 / 60);
}
```

A session that runs ahead runs a tick again after a rewind, and a game that keeps something it reads outside the world runs it differently. `Session.syncTest(game, { seed })` finds such a tick with one app and no second peer. It makes the app and steps it, as a session does, and `test.app` is that app.

- Each tick is run, rewound and run again from the same moment.
- The world's hash is compared before the first system and after each one.
- `tick` fails with `Session.RewindDiverged`, which names the first system after which the hashes differ. A difference before any system is in a handler of an action queued for the tick, or in a state's hook.

The rest of the game sees each tick once: the frame and input stages, the action log and the recording. An action enqueued from outside is queued for the next tick, as in an app nobody took over. Each tick costs a capture of the game, a second run and a hash per system, so use it in tests.

## Read more

- [Sessions](sessions.md), and [detecting drift](detecting-drift.md) between peers.
- [Transports and relays](transports-and-relays.md), what carries messages between machines.
