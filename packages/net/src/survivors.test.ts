import { GameLoop } from "@gamekit/runtime";
import type { StepInput } from "@gamekit/runtime";
import { GameContent, survivorsSimulation } from "@gamekit/survivors";
import type {
  SurvivorsConfig,
  SurvivorsInput,
  World,
} from "@gamekit/survivors";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { schemaCodec } from "./codec";
import { hostLockstep, joinLockstep } from "./lockstep";
import type { ConfirmedStep, LockstepOptions } from "./lockstep";
import { createMemoryNetwork } from "./memory-network";
import type { MemoryNetwork } from "./memory-network";
import { hasher, runNetwork } from "./test-harness";

// Survivors' real simulation in lockstep. Survivors is single-player until #25's genre work gives
// its World N players, so for now every peer runs the same one-hero world and the step input is
// the host's input alone; the other players' inputs still cross the network and are confirmed
// with it. Level-ups are out of reach (xpToLevel2 is huge): an upgrade pick needs a
// step-scheduled input, which also comes with the genre work.

const content = Schema.decodeUnknownSync(GameContent)({
  rules: {
    arenaHalfSize: 30,
    maxEnemies: 200,
    xpToLevel2: 1_000_000,
    xpGrowth: 1.3,
    baseMoveSpeedScale: 1,
    basePickupRadius: 2.5,
    choicesPerLevelUp: 3,
    runLength: 90,
  },
  heroes: [
    {
      id: "bolter",
      name: "Bolter",
      description: "",
      color: "#ffffff",
      maxHp: 400,
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
  ],
  passives: [],
  waves: [{ from: 0, to: 90, enemy: "grunt", perSecond: 4 }],
});

/** Hashes the clock, kills, the player, the weapon slots and every live entity in the pools. */
const hashWorld = (world: World): number => {
  const h = hasher();
  h.add(world.time);
  h.add(world.kills);
  for (const value of Object.values(world.player)) {
    h.add(value);
  }
  for (const slot of world.weapons) {
    h.add(slot.level);
    h.add(slot.timer);
  }
  for (const pool of [world.enemies, world.projectiles, world.gems]) {
    h.add(pool.count);
    for (const array of Object.values(pool.fields)) {
      for (let i = 0; i < pool.count; i++) {
        h.add(array[i]!);
      }
    }
  }
  return h.value;
};

const SurvivorsInputSchema = Schema.Struct({
  moveX: Schema.Number,
  moveZ: Schema.Number,
});

/** Zig-zag movement, a leg every 90 steps; each player turns differently. One object, refilled. */
const zigZag = (turn: number): StepInput<SurvivorsInput> => {
  const input = { moveX: 0, moveZ: 0 };
  return {
    read: (step) => {
      const leg = Math.floor(step / 90) % 4;
      input.moveX = [1, turn, -1, turn][leg]!;
      input.moveZ = leg % 2;
      return input;
    },
  };
};

/** The step input: the host's input alone. One object, refilled each step. */
const hostOnly = () => {
  const input = { moveX: 0, moveZ: 0 };
  return (step: ConfirmedStep<SurvivorsInput>): SurvivorsInput => {
    const host = step.inputs[0]!.input;
    input.moveX = host.moveX;
    input.moveZ = host.moveZ;
    return input;
  };
};

/** Survivors' simulation, with the world's hash recorded after every step. */
const recorded = () => {
  const hashes: number[] = [];
  const simulation = {
    ...survivorsSimulation,
    step: (world: World, input: SurvivorsInput, dt: number) => {
      survivorsSimulation.step(world, input, dt);
      hashes.push(hashWorld(world));
    },
  };
  return { hashes, simulation };
};

const SEED = 1234;
const TURNS: Record<string, number> = { host: 0.3, p1: -0.4, p2: 0.7 };

const options = (network: MemoryNetwork, id: string) => {
  const { hashes, simulation } = recorded();
  const session: LockstepOptions<
    SurvivorsConfig,
    World,
    SurvivorsInput,
    unknown,
    SurvivorsInput
  > = {
    simulation,
    config: { content, heroId: "bolter" },
    contentHash: "survivors-test-content",
    transport: network.connect(id),
    local: zigZag(TURNS[id]!),
    codec: schemaCodec(SurvivorsInputSchema),
    combine: hostOnly(),
    hash: hashWorld,
    inputDelay: 4,
    hashEvery: 30,
  };
  return { hashes, session };
};

/** The host's run played alone through GameLoop: what every peer must match. */
const soloHashes = (steps: number) => {
  const { hashes, simulation } = recorded();
  const loop = new GameLoop(simulation);
  loop.start({ content, heroId: "bolter" }, SEED, 0);
  loop.frame(zigZag(TURNS.host!), { steps }, 0);
  return { hashes, world: loop.state! };
};

describe("survivors in lockstep", () => {
  it("plays the same run on three peers over a lossy, jittery network", () => {
    const network = createMemoryNetwork({
      seed: 5,
      latencyMs: 25,
      jitterMs: 20,
      loss: 0.1,
    });
    const host = options(network, "host");
    const p1 = options(network, "p1");
    const p2 = options(network, "p2");
    const sessions = [
      hostLockstep({ ...host.session, peers: ["p1", "p2"], seed: SEED }, 0),
      joinLockstep({ ...p1.session, host: "host" }, 0),
      joinLockstep({ ...p2.session, host: "host" }, 0),
    ];
    runNetwork(
      network,
      sessions.map((session, i) => ({ session, everyMs: [4, 5, 6][i]! })),
      0,
      10_000
    );
    const solo = soloHashes(600);
    // The run must get somewhere, or matching hashes prove little.
    expect(solo.world.kills).toBeGreaterThan(5);
    for (const [session, { hashes }] of [
      [sessions[0]!, host],
      [sessions[1]!, p1],
      [sessions[2]!, p2],
    ] as const) {
      expect(session.error).toBeNull();
      expect(session.stepIndex).toBeGreaterThan(400);
      const steps = Math.min(session.stepIndex, 600);
      expect(hashes.slice(0, steps)).toStrictEqual(solo.hashes.slice(0, steps));
    }
  });
});
