import {
  createMemoryNetwork,
  hostLockstep,
  joinLockstep,
  schemaCodec,
} from "arcadekit/net";
import type {
  LockstepOptions,
  LockstepSession,
  MemoryNetwork,
} from "arcadekit/net";
import { GameLoop } from "arcadekit/runtime";
import type { StepInput } from "arcadekit/runtime";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { SurvivorsEvent } from "./events";
import { hashWorld } from "./hash-world";
import type { Hero } from "./hero";
import { HeroInput, combineHeroInputs } from "./input";
import type { SurvivorsInput } from "./input";
import { GameContent } from "./schema";
import { survivorsSimulation } from "./simulation";
import type { SurvivorsConfig, World } from "./world";

// Survivors' real simulation in lockstep, one hero per player: three peers, each driving its own
// hero, over a lossy, jittery in-memory network. Every peer must step through the same states as
// every other, step for step, including level-ups each player answers with its own pick, and a
// player the host removes.

const decode = Schema.decodeUnknownSync(GameContent);

const content = (xpToLevel2: number) =>
  decode({
    rules: {
      arenaHalfSize: 30,
      maxEnemies: 200,
      xpToLevel2,
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
      {
        id: "burner",
        name: "Burner",
        description: "",
        color: "#ff0000",
        maxHp: 400,
        moveSpeed: 5,
        startingWeapon: "aura",
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
    waves: [{ from: 0, to: 90, enemy: "grunt", perSecond: 4 }],
  });

const SEED = 1234;
const PLAYERS = ["host", "p1", "p2"] as const;
const HERO_IDS = ["bolter", "burner", "bolter"];
const TURNS = [0.3, -0.4, 0.7] as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Zig-zag movement, a leg every 90 steps; each player turns differently. A pure function of the step. */
const zigZag = (turn: number, step: number, input: Mutable<HeroInput>) => {
  const leg = Math.floor(step / 90) % 4;
  input.moveX = [1, turn, -1, turn][leg]!;
  input.moveZ = leg % 2;
  return input;
};

/**
 * Player `slot`'s script: its zig-zag, and, when `picks`, choice `slot % length` of every offer
 * its hero has open in the session's current state. One object, refilled.
 */
const script = (
  slot: number,
  picks: boolean,
  state: () => World | null
): StepInput<HeroInput> => {
  const input: Mutable<HeroInput> = { moveX: 0, moveZ: 0 };
  return {
    read: (step) => {
      zigZag(TURNS[slot]!, step, input);
      const world = state();
      const offer = world?.heroes[slot]!.offer;
      if (picks && world && offer) {
        input.pick = { offer: world.offerSeq, index: slot % offer.length };
      } else {
        delete input.pick;
      }
      return input;
    },
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

type Session = LockstepSession<World, SurvivorsEvent>;

interface Peer {
  readonly session: Session;
  readonly hashes: number[];
}

interface RunOptions {
  readonly xpToLevel2: number;
  /** Which players pick their upgrades. */
  readonly picking: readonly boolean[];
  readonly dropAfterMs?: number;
}

/** Starts a three-player run: the host and two peers, each on its own network connection. */
const startRun = (network: MemoryNetwork, run: RunOptions): Peer[] => {
  const config: SurvivorsConfig = {
    content: content(run.xpToLevel2),
    heroIds: HERO_IDS,
  };
  return PLAYERS.map((id, slot) => {
    const { hashes, simulation } = recorded();
    let session: Session | null = null;
    const options: LockstepOptions<
      SurvivorsConfig,
      World,
      SurvivorsInput,
      SurvivorsEvent,
      HeroInput
    > = {
      simulation,
      config,
      contentHash: "survivors-test-content",
      transport: network.connect(id),
      local: script(slot, run.picking[slot]!, () => session?.state ?? null),
      codec: schemaCodec(HeroInput),
      combine: combineHeroInputs(PLAYERS),
      hash: hashWorld,
      inputDelay: 4,
      hashEvery: 30,
      ...(run.dropAfterMs === undefined
        ? {}
        : { dropAfterMs: run.dropAfterMs }),
    };
    session =
      slot === 0
        ? hostLockstep({ ...options, peers: ["p1", "p2"], seed: SEED }, 0)
        : joinLockstep({ ...options, host: "host" }, 0);
    return { session, hashes };
  });
};

/** Advances the network and ticks each session on its own timer, as arcadekit/net's tests do. */
const runNetwork = (
  network: MemoryNetwork,
  peers: readonly Peer[],
  fromMs: number,
  toMs: number
) => {
  for (let nowMs = fromMs; nowMs <= toMs; nowMs++) {
    network.advance(nowMs);
    for (let i = 0; i < peers.length; i++) {
      if (nowMs % (4 + i) === 0) {
        peers[i]!.session.tick(nowMs);
      }
    }
  }
};

const lossy = () =>
  createMemoryNetwork({ seed: 5, latencyMs: 25, jitterMs: 20, loss: 0.1 });

/** The hashes each peer recorded, cut to the steps every one of `peers` has run. */
const commonHashes = (peers: readonly Peer[]) => {
  const steps = Math.min(...peers.map((peer) => peer.session.stepIndex));
  return peers.map((peer) => peer.hashes.slice(0, steps));
};

/** How many upgrades a hero has taken: weapon levels past its first weapon's first, and passive levels. */
const upgrades = (hero: Hero) =>
  hero.weapons.reduce((sum, slot) => sum + slot.level, -1) +
  [...hero.passiveLevels.values()].reduce((sum, level) => sum + level, 0);

/** A hero's weapons and passives with their levels, as text. */
const loadout = (hero: Hero) =>
  JSON.stringify([
    hero.weapons.map((slot) => [slot.def.id, slot.level]),
    [...hero.passiveLevels],
  ]);

/** The run played alone through GameLoop, every player's zig-zag in one step input: what every peer must match. */
const soloHashes = (steps: number) => {
  const { hashes, simulation } = recorded();
  const loop = new GameLoop(simulation);
  loop.start({ content: content(1_000_000), heroIds: HERO_IDS }, SEED, 0);
  const heroes = TURNS.map(() => ({ moveX: 0, moveZ: 0 }));
  const input: SurvivorsInput = { heroes, leaving: [] };
  loop.frame(
    {
      read: (step) => {
        for (const [slot, turn] of TURNS.entries()) {
          zigZag(turn, step, heroes[slot]!);
        }
        return input;
      },
    },
    { steps },
    0
  );
  return { hashes, world: loop.state! };
};

describe("survivors in lockstep", () => {
  it("plays the same run on three peers, each moving its own hero", () => {
    const network = lossy();
    const peers = startRun(network, {
      xpToLevel2: 1_000_000,
      picking: [false, false, false],
    });
    runNetwork(network, peers, 0, 10_000);
    const solo = soloHashes(600);
    // The run must get somewhere, or matching hashes prove little.
    expect(solo.world.kills).toBeGreaterThan(5);
    for (const { session, hashes } of peers) {
      expect(session.error).toBeNull();
      expect(session.stepIndex).toBeGreaterThan(400);
      const steps = Math.min(session.stepIndex, 600);
      expect(hashes.slice(0, steps)).toStrictEqual(solo.hashes.slice(0, steps));
    }
  });

  it("levels up together, each player picking its own upgrade", () => {
    const network = lossy();
    const peers = startRun(network, {
      xpToLevel2: 3,
      picking: [true, true, true],
    });
    runNetwork(network, peers, 0, 15_000);
    const [host, p1, p2] = commonHashes(peers);
    const world = peers[0]!.session.state!;
    expect([
      ...peers.map((peer) => peer.session.error),
      host!.length > 400,
      world.level > 2,
    ]).toStrictEqual([null, null, null, true, true]);
    expect([p1, p2]).toStrictEqual([host, host]);
    // Every hero took an upgrade for each finished level-up, and the two bolters chose differently.
    const done = world.level - 1 - world.pendingLevelUps;
    expect(world.heroes.map((hero) => upgrades(hero) >= done)).toStrictEqual([
      true,
      true,
      true,
    ]);
    expect(loadout(world.heroes[0]!)).not.toBe(loadout(world.heroes[2]!));
  });

  it("drops a silent player's hero at the same step on every peer, and plays on", () => {
    const network = lossy();
    // p2 never picks, so the first level-up waits on it until the host removes it.
    const peers = startRun(network, {
      xpToLevel2: 3,
      picking: [true, true, false],
      dropAfterMs: 2000,
    });
    runNetwork(network, peers, 0, 8000);
    const frozen = peers[0]!.session.state!;
    expect(frozen.heroes[2]!.offer).not.toBeNull();
    network.cutOff("p2", true);
    runNetwork(network, peers, 8001, 20_000);
    const [host, p1] = peers;
    expect([host!.session.error, p1!.session.error]).toStrictEqual([
      null,
      null,
    ]);
    expect(
      [host!, p1!].map((peer) =>
        peer.session.state!.heroes.map((hero) => hero.status)
      )
    ).toStrictEqual([
      ["playing", "playing", "left"],
      ["playing", "playing", "left"],
    ]);
    // Hashes cover hero status, so equal hashes mean both removed p2's hero at the same step.
    const [hostHashes, p1Hashes] = commonHashes([host!, p1!]);
    expect(p1Hashes).toStrictEqual(hostHashes);
    // The level-up p2 never answered closed when it left, and the run went on to level again.
    expect(host!.session.state!.level).toBeGreaterThan(2);
  });
});
