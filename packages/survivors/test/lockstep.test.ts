import * as Game from "arcadekit/game";
import { LockstepSession, MemoryNetwork } from "arcadekit/net";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ChooseUpgrade, HoldPause } from "../src/commands";
import * as GameContent from "../src/game-content";
import type * as Hero from "../src/hero";
import { Survivors } from "../src/simulation";
import * as World from "../src/world";

// Survivors' declared simulation in lockstep, one hero per player: three peers, each driving its
// own hero, over a lossy, jittery in-memory network. Every peer must step through the same
// states as every other, step for step, including level-ups each player answers with its own
// pick, a pause one player holds for everyone, and a player the host removes. A pick and a pause
// are commands, sent through each peer's session. The peers compare their hashes after every
// step (`hashEvery: 1`), and the test keeps each peer's to compare them itself.

const decode = Schema.decodeUnknownSync(GameContent.GameContent);

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
const zigZag = (turn: number, step: number, input: Mutable<Hero.Input>) => {
  const leg = Math.floor(step / 90) % 4;
  input.moveX = [1, turn, -1, turn][leg]!;
  input.moveZ = leg % 2;
  return input;
};

/** Player `slot`'s device: its zig-zag. One object, refilled. */
const script = (slot: number): Game.StepInput<Hero.Input> => {
  const input: Mutable<Hero.Input> = { moveX: 0, moveZ: 0 };
  return { read: (step) => zigZag(TURNS[slot]!, step, input) };
};

/** A session's `hash` that also keeps each hash: with `hashEvery: 1`, the world's after every step. */
const recorded = () => {
  const hashes: number[] = [];
  const hash = (world: World.Arena) => {
    const hashed = World.hash(world);
    hashes.push(hashed);
    return hashed;
  };
  return { hashes, hash };
};

/** The rejections each of survivors' commands can be refused with. */
type Refusals = Game.RefusalsOf<
  readonly [typeof ChooseUpgrade, typeof HoldPause]
>;

type Session = LockstepSession.LockstepSession<
  World.Arena,
  Game.EventOf<typeof Survivors>,
  Game.CommandOf<typeof Survivors>,
  Refusals
>;

interface Peer {
  readonly slot: number;
  readonly session: Session;
  readonly hashes: number[];
  /** Whether this player picks its upgrades. */
  readonly picking: boolean;
  /** The number of the last offer this player answered. */
  answered: number;
  /** How each of its picks ended: "taken", or the rejection's tag or the drop's. */
  readonly picks: string[];
}

interface RunOptions {
  readonly xpToLevel2: number;
  /** Which players pick their upgrades. */
  readonly picking: readonly boolean[];
  readonly dropAfterMs?: number;
}

/** Starts a three-player run: the host and two peers, each on its own network connection. */
const startRun = (
  network: MemoryNetwork.MemoryNetwork,
  run: RunOptions
): Peer[] => {
  const config: World.Config = {
    content: content(run.xpToLevel2),
    heroIds: HERO_IDS,
  };
  return PLAYERS.map((id, slot) => {
    const { hashes, hash } = recorded();
    const options: LockstepSession.Options<
      World.Config,
      World.Arena,
      World.Input,
      Game.EventOf<typeof Survivors>,
      Game.CommandOf<typeof Survivors>,
      Refusals
    > = {
      simulation: Survivors,
      config,
      contentHash: "survivors-test-content",
      transport: MemoryNetwork.connect(network, id),
      local: script(slot),
      hash,
      inputDelay: 4,
      hashEvery: 1,
      ...(run.dropAfterMs === undefined
        ? {}
        : { dropAfterMs: run.dropAfterMs }),
    };
    const session =
      slot === 0
        ? LockstepSession.host(
            { ...options, peers: ["p1", "p2"], seed: SEED },
            0
          )
        : LockstepSession.join(
            { ...options, host: "host", players: PLAYERS },
            0
          );
    return {
      slot,
      session,
      hashes,
      picking: run.picking[slot]!,
      answered: 0,
      picks: [],
    };
  });
};

/**
 * What a player's app does after a tick: it answers its hero's open offer once, with choice
 * `slot % length`, as the `ChooseUpgrade` command.
 */
const pick = (peer: Peer) => {
  const world = peer.session.state;
  const offer = world?.heroes[peer.slot]!.offer ?? null;
  if (
    !peer.picking ||
    world === null ||
    offer === null ||
    peer.answered === world.offerSeq
  ) {
    return;
  }
  peer.answered = world.offerSeq;
  peer.session.send(
    new ChooseUpgrade({
      offer: world.offerSeq,
      index: peer.slot % offer.length,
    }),
    (outcome) => peer.picks.push(outcome?._tag ?? "taken")
  );
};

/** Advances the network and ticks each session on its own timer, as arcadekit/net's tests do. */
const runNetwork = (
  network: MemoryNetwork.MemoryNetwork,
  peers: readonly Peer[],
  fromMs: number,
  toMs: number
) => {
  for (let nowMs = fromMs; nowMs <= toMs; nowMs++) {
    MemoryNetwork.advance(network, nowMs);
    for (let i = 0; i < peers.length; i++) {
      if (nowMs % (4 + i) === 0) {
        peers[i]!.session.tick(nowMs);
        pick(peers[i]!);
      }
    }
  }
};

const lossy = () =>
  MemoryNetwork.make({ seed: 5, latencyMs: 25, jitterMs: 20, loss: 0.1 });

/** The hashes each peer recorded, cut to the steps every one of `peers` has run. */
const commonHashes = (peers: readonly Peer[]) => {
  const steps = Math.min(...peers.map((peer) => peer.session.stepIndex));
  return peers.map((peer) => peer.hashes.slice(0, steps));
};

/** How many upgrades a hero has taken: weapon levels past its first weapon's first, and passive levels. */
const upgrades = (hero: Hero.Hero) =>
  hero.weapons.reduce((sum, slot) => sum + slot.level, -1) +
  [...hero.passiveLevels.values()].reduce((sum, level) => sum + level, 0);

/** A hero's weapons and passives with their levels, as text. */
const loadout = (hero: Hero.Hero) =>
  JSON.stringify([
    hero.weapons.map((slot) => [slot.def.id, slot.level]),
    [...hero.passiveLevels],
  ]);

/** The run played alone through `Game.Loop`, every player's zig-zag in one step input: what every peer must match. */
const soloHashes = (steps: number) => {
  const hashes: number[] = [];
  const loop = Game.makeLoop(Survivors);
  loop.start({ content: content(1_000_000), heroIds: HERO_IDS }, SEED, 0);
  const world = loop.state!;
  const players = TURNS.map(() => ({ moveX: 0, moveZ: 0 }));
  const input: World.Input = { players, leaving: [] };
  const source: Game.StepInput<World.Input> = {
    read: (step) => {
      for (const [slot, turn] of TURNS.entries()) {
        zigZag(turn, step, players[slot]!);
      }
      return input;
    },
  };
  for (let step = 0; step < steps; step++) {
    loop.frame(source, { steps: 1 }, 0);
    hashes.push(World.hash(world));
  }
  return { hashes, world };
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
    // Each player sent one pick an offer, and every peer's rules took each: a pick rides one
    // step, so none arrives twice or late.
    expect(
      peers.map((peer) => [
        peer.picks.length >= world.level - 2,
        new Set(peer.picks),
      ])
    ).toStrictEqual([
      [true, new Set(["taken"])],
      [true, new Set(["taken"])],
      [true, new Set(["taken"])],
    ]);
    // Every hero took an upgrade for each finished level-up, and the two bolters chose differently.
    const done = world.level - 1 - world.pendingLevelUps;
    expect(world.heroes.map((hero) => upgrades(hero) >= done)).toStrictEqual([
      true,
      true,
      true,
    ]);
    expect(loadout(world.heroes[0]!)).not.toBe(loadout(world.heroes[2]!));
  });

  it("holds the run on every peer while one player holds the pause, and plays on when it lets go", () => {
    const network = lossy();
    const peers = startRun(network, {
      xpToLevel2: 1_000_000,
      picking: [false, false, false],
    });
    const [, p1] = peers;
    const told: (string | undefined)[] = [];
    const times = () => peers.map((peer) => peer.session.state!.time);
    runNetwork(network, peers, 0, 2000);
    p1!.session.send(new HoldPause({ held: true }), (outcome) =>
      told.push(outcome?._tag)
    );
    runNetwork(network, peers, 2001, 4000);
    const held = times();
    const heldBy = peers.map((peer) =>
      peer.session.state!.heroes.map((hero) => hero.paused)
    );
    runNetwork(network, peers, 4001, 6000);
    const stillHeld = times();
    p1!.session.send(new HoldPause({ held: false }), (outcome) =>
      told.push(outcome?._tag)
    );
    runNetwork(network, peers, 6001, 9000);
    expect(peers.map((peer) => peer.session.error)).toStrictEqual([
      null,
      null,
      null,
    ]);
    // Every peer's clock stood at the same time, and the steps went on: a frozen run still
    // steps, so the peers stay in touch.
    expect([held, stillHeld]).toStrictEqual([
      [held[0], held[0], held[0]],
      [held[0], held[0], held[0]],
    ]);
    expect(heldBy).toStrictEqual([
      [false, true, false],
      [false, true, false],
      [false, true, false],
    ]);
    expect(times().map((time) => time > held[0]!)).toStrictEqual([
      true,
      true,
      true,
    ]);
    // The pause is in the state every peer hashes: they agreed at every step, through both.
    const [host, ...others] = commonHashes(peers);
    expect([told, others]).toStrictEqual([
      [undefined, undefined],
      [host, host],
    ]);
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
    MemoryNetwork.cutOff(network, "p2", true);
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
