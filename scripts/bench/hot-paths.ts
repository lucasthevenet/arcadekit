import { setImmediate as settle } from "node:timers/promises";
import { getHeapSpaceStatistics } from "node:v8";

import * as Game from "arcadekit/game/browser";
import { ManualFrames } from "arcadekit/game/testing";
import { MemoryNetwork, ScopedLockstepSession } from "arcadekit/net";
import { ManualTicker, TestGame } from "arcadekit/net/testing";
import { Clock, Effect, Layer, Schema } from "effect";

// The kit's hot paths, each timed and its allocations counted:
//
// - survivors' step at its largest test population, a horde held at the 300 enemies its world
//   tests cap it at, stepped by `Game.Loop`;
// - an engine's frames, each of which steps and draws, run on `ManualFrames`;
// - a lockstep run's ticks: two peers' scoped sessions over the in-memory network, ticked by
//   `ManualTicker` on a Clock the bench moves.
//
// Each workload is the same on every run: seeded, with time given by the bench. Only the timings
// move. The time is the median of several rounds. The heap is counted over one more round, from a
// collected heap, with a young generation too large to collect during it and the engine's
// compiler on the main thread (run.ts), so the count is the same on every run.
import {
  ChooseUpgrade,
  GameContent,
  Survivors,
} from "../../apps/survivor-demo/src/survivors";
import type { Hero, World } from "../../apps/survivor-demo/src/survivors";

declare const gc: () => void;

interface Result {
  /** Nanoseconds per operation: the median of the rounds. */
  readonly nanos: number;
  /** Bytes the heap grew by per operation, over one round. */
  readonly bytes: number;
  /** Collections that ran while the heap was counted: a count with one is too low. */
  readonly collections: number;
}

/**
 * The bytes of the heap's spaces that hold a program's objects, young and old, large or not.
 * Not compiled code and bytecode (`code_space`, `trusted_space`): a function the engine
 * optimizes while a round is counted is no allocation of the hot path.
 */
const OBJECT_SPACES = new Set([
  "new_space",
  "new_large_object_space",
  "old_space",
  "large_object_space",
]);

const objectBytes = (): number => {
  let used = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (OBJECT_SPACES.has(space.space_name)) {
      used += space.space_used_size;
    }
  }
  return used;
};

const collectionsBetween = (
  entries: readonly PerformanceEntry[],
  from: number,
  to: number
) =>
  entries.filter((entry) => entry.startTime >= from && entry.startTime <= to)
    .length;

const measure = async (
  operate: () => void,
  {
    warmup,
    perRound,
    rounds,
  }: { warmup: number; perRound: number; rounds: number }
): Promise<Result> => {
  const collections: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => {
    collections.push(...list.getEntries());
  });
  observer.observe({ entryTypes: ["gc"] });
  for (let i = 0; i < warmup; i++) {
    operate();
  }
  const nanos: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < perRound; i++) {
      operate();
    }
    nanos.push(Number(process.hrtime.bigint() - start) / perRound);
  }
  gc();
  // Runs the macrotasks due, so the collection's performance entry has been delivered.
  await settle();
  const from = performance.now();
  const before = objectBytes();
  for (let i = 0; i < perRound; i++) {
    operate();
  }
  const after = objectBytes();
  const to = performance.now();
  await settle();
  observer.disconnect();
  nanos.sort((a, b) => a - b);
  return {
    nanos: nanos[Math.floor(nanos.length / 2)]!,
    bytes: (after - before) / perRound,
    collections: collectionsBetween(collections, from, to),
  };
};

// Survivors: the world tests' content and cap, with a hero no horde can kill, a wave that keeps
// the horde at its cap, and a run longer than the bench.

const SURVIVORS_CAP = 300;

const content = Schema.decodeUnknownSync(GameContent.GameContent)({
  rules: {
    arenaHalfSize: 40,
    maxEnemies: SURVIVORS_CAP,
    xpToLevel2: 3,
    xpGrowth: 1.3,
    baseMoveSpeedScale: 1,
    basePickupRadius: 2.5,
    choicesPerLevelUp: 3,
    runLength: 100_000,
  },
  heroes: [
    {
      id: "bolter",
      name: "Bolter",
      description: "",
      color: "#ffffff",
      maxHp: 1e9,
      moveSpeed: 6,
      startingWeapon: "bolt",
    },
  ],
  enemies: [
    {
      id: "grunt",
      name: "Grunt",
      color: "#00ff00",
      hp: 8,
      speed: 2.5,
      damage: 10,
      radius: 0.45,
      xp: 1,
    },
  ],
  weapons: [
    {
      id: "bolt",
      name: "Bolt",
      description: "",
      color: "#ffff00",
      damage: 10,
      damagePerLevel: 3,
      cooldown: 0.5,
      cooldownScalePerLevel: 0.9,
      maxLevel: 5,
      behavior: {
        kind: "bolt",
        projectileSpeed: 20,
        count: 1,
        countPerLevel: 0.5,
        pierce: 1,
        range: 14,
      },
    },
    {
      id: "aura",
      name: "Aura",
      description: "",
      color: "#ff8800",
      damage: 6,
      damagePerLevel: 2,
      cooldown: 0.5,
      cooldownScalePerLevel: 0.95,
      maxLevel: 5,
      behavior: { kind: "aura", radius: 2.6, radiusPerLevel: 0.3 },
    },
  ],
  passives: [
    {
      id: "power",
      name: "Power",
      description: "",
      stat: "damage",
      amountPerLevel: 0.1,
      maxLevel: 3,
    },
  ],
  waves: [{ from: 0, to: 100_000, enemy: "grunt", perSecond: 120 }],
});

const survivorsStep = async () => {
  const loop = Game.makeLoop(Survivors);
  const move = { moveX: 0, moveZ: 0 };
  // A slow circle, as the world tests walk.
  const input = Game.soloInput<Hero.Input>({
    read: (step) => {
      move.moveX = Math.cos(step / 200);
      move.moveZ = Math.sin(step / 200);
      return move;
    },
  });
  const config: World.Config = { content, heroIds: ["bolter"] };
  loop.start(config, 1, 0);
  const world = loop.state!;
  const budget = { steps: 1 } as const;
  let step = 0;
  let enemies = 0;
  let counted = 0;
  const operate = () => {
    const { offer } = world.heroes[0]!;
    if (offer) {
      loop.send(new ChooseUpgrade({ offer: world.offerSeq, index: 0 }));
    }
    step += 1;
    loop.frame(input, budget, (step * 1000) / 60);
    enemies += world.enemies.count;
    counted += 1;
  };
  // 10 seconds of warmup fill the horde to its cap.
  const result = await measure(operate, {
    warmup: 600,
    perRound: 1200,
    rounds: 5,
  });
  return { result, enemies: enemies / counted };
};

// An engine: a run that counts its steps and samples them every 100 ms, as a HUD is, drawn by
// a view that reads the state, with an input of nothing.

class BenchCounted extends Game.Event("BenchCounted", { steps: Schema.Int }) {}

class BenchCounter extends Game.Simulation("BenchCounter", {
  // 1/64 s steps and frames: their times are exact in floating point, so each frame steps once.
  stepSeconds: 1 / 64,
  input: Schema.Null,
  create: (_config: null) => ({ steps: 0 }),
  step: (state) => {
    state.steps += 1;
  },
  sample: {
    event: BenchCounted,
    every: "100 millis",
    read: (state) => ({ steps: state.steps }),
  },
}) {}

let drawn = 0;

class BenchEngine extends Game.Engine("BenchEngine", {
  simulation: BenchCounter,
  view: () => ({
    render: (state) => {
      drawn = state?.steps ?? -1;
    },
    dispose: () => undefined,
  }),
  input: () => ({ read: () => null, dispose: () => undefined }),
}) {}

const element = { id: "bench" } as HTMLElement;

const engineFrames = () => {
  const frames = ManualFrames.make();
  let nowMs = 0;
  const operate = () => {
    nowMs += 15.625;
    ManualFrames.runFrameAt(frames, nowMs);
  };
  return Effect.gen(function* () {
    const engine = yield* BenchEngine;
    yield* engine.start(null, { seed: 1 });
    yield* Effect.forkScoped(engine.attach(element), {
      startImmediately: true,
    });
    const result = yield* Effect.promise(() =>
      measure(operate, { warmup: 2000, perRound: 6000, rounds: 5 })
    );
    // Every frame stepped once and drew: a frame the loop missed would show here.
    const frameCount = 2000 + 6000 * 6;
    if (drawn !== frameCount) {
      throw new Error(
        `The engine drew step ${drawn} after ${frameCount} frames`
      );
    }
    return result;
  }).pipe(
    Effect.scoped,
    Effect.provide(
      BenchEngine.layer.pipe(Layer.provide(Layer.succeed(Game.Frames, frames)))
    )
  );
};

// A lockstep run: a host and a guest of the test game, over a network that loses nothing and
// delivers at once, each ticked every 4 ms, as a session on its own Clock is.

const TICK_MS = 4;

const lockstepTicks = () => {
  let nowMs = 0;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => nowMs,
    currentTimeMillis: Effect.sync(() => nowMs),
    currentTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(nowMs) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(nowMs) * 1_000_000n),
    sleep: () => Effect.never,
  };
  const network = MemoryNetwork.make({ seed: 1 });
  const ticks = ManualTicker.make();
  const operate = () => {
    nowMs += TICK_MS;
    MemoryNetwork.advance(network, nowMs);
    ManualTicker.tick(ticks);
  };
  const shared = {
    simulation: TestGame.TestGame,
    config: { content: TestGame.content, picks: ["red", "green"] },
    contentHash: "bench",
    local: { read: (step: number) => ({ add: step % 3 }) },
    hash: TestGame.hash,
    inputDelay: 3,
    hashEvery: 10,
  };
  return Effect.gen(function* () {
    const host = yield* ScopedLockstepSession.host({
      ...shared,
      transport: MemoryNetwork.connect(network, "host"),
      peers: ["guest"],
      seed: 1,
    });
    const guest = yield* ScopedLockstepSession.join({
      ...shared,
      transport: MemoryNetwork.connect(network, "guest"),
      host: "host",
      players: ["host", "guest"],
    });
    yield* Effect.forkScoped(host.run(ticks.ticker), {
      startImmediately: true,
    });
    yield* Effect.forkScoped(guest.run(ticks.ticker), {
      startImmediately: true,
    });
    const result = yield* Effect.promise(() =>
      measure(operate, { warmup: 2000, perRound: 6000, rounds: 5 })
    );
    // Both peers stepped the run together, with no stall.
    const steps = [host.stepIndex, guest.stepIndex];
    if (
      host.status !== "running" ||
      guest.status !== "running" ||
      Math.abs(steps[0]! - steps[1]!) > 1 ||
      steps[0]! < 1000
    ) {
      throw new Error(
        `The lockstep run stalled: ${host.status} and ${guest.status} at steps ${steps.join(" and ")}`
      );
    }
    return { result, steps: steps[0]! };
  }).pipe(Effect.scoped, Effect.provideService(Clock.Clock, clock));
};

const micros = (nanos: number) => `${(nanos / 1000).toFixed(2)} µs`;

const bytes = (perOperation: number) =>
  `${Math.round(perOperation).toLocaleString("en")} B`;

const line = (name: string, unit: string, result: Result) =>
  `${name.padEnd(40)} ${`${micros(result.nanos)}/${unit}`.padStart(16)} ${`${bytes(result.bytes)}/${unit}`.padStart(16)}${result.collections === 0 ? "" : `  (a collection ran while counting: too low)`}`;

const survivors = await survivorsStep();
const engine = await Effect.runPromise(engineFrames());
const lockstep = await Effect.runPromise(lockstepTicks());

console.log(
  `${"hot path".padEnd(40)} ${"wall time".padStart(16)} ${"heap allocated".padStart(16)}`
);
console.log(
  line(
    `survivors step (${survivors.enemies.toFixed(0)} enemies on average)`,
    "step",
    survivors.result
  )
);
console.log(line("engine frame (ManualFrames)", "frame", engine));
console.log(
  line(
    `lockstep tick (2 peers, ${lockstep.steps} steps)`,
    "tick",
    lockstep.result
  )
);
