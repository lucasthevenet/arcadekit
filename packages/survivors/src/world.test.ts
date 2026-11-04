import { GameLoop } from "@gamekit/runtime";
import type { StepInput } from "@gamekit/runtime";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { hashWorld } from "./hash-world";
import {
  GameContent,
  chooseUpgrade,
  createWorld,
  findBrokenReferences,
  hudSample,
  soloInput,
  step,
  survivorsSimulation,
} from "./index";
import type { HeroInput, SurvivorsEvent, SurvivorsInput, World } from "./index";

// Small, self-contained content so these tests don't depend on any particular game.
const content = Schema.decodeUnknownSync(GameContent)({
  rules: {
    arenaHalfSize: 40,
    maxEnemies: 300,
    xpToLevel2: 3,
    xpGrowth: 1.3,
    baseMoveSpeedScale: 1,
    basePickupRadius: 2.5,
    choicesPerLevelUp: 3,
    runLength: 120,
  },
  heroes: [
    {
      id: "bolter",
      name: "Bolter",
      description: "",
      color: "#ffffff",
      maxHp: 100,
      moveSpeed: 6,
      startingWeapon: "bolt",
    },
    {
      id: "burner",
      name: "Burner",
      description: "",
      color: "#ff0000",
      maxHp: 120,
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
        pierce: 0,
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
  waves: [{ from: 0, to: 120, enemy: "grunt", perSecond: 3 }],
});

const DT = 1 / 60;

const STILL: SurvivorsInput = { heroes: [], leaving: [] };

/** One step's input: each hero's, by slot. */
const inputs = (
  ...heroes: (HeroInput | null)[]
): { heroes: (HeroInput | null)[]; leaving: number[] } => ({
  heroes,
  leaving: [],
});

const solo = (moveX: number, moveZ: number): SurvivorsInput =>
  inputs({ moveX, moveZ });

/** Plays `seconds` of a run: walks in a slow circle and always takes the first upgrade. Returns all events. */
const play = (world: World, seconds: number): SurvivorsEvent[] => {
  const events: SurvivorsEvent[] = [];
  for (
    let frame = 0;
    frame < seconds * 60 && world.status === "running";
    frame++
  ) {
    if (world.heroes[0]!.offer) {
      chooseUpgrade(world, 0, 0);
    }
    const angle = frame / 200;
    step(world, solo(Math.cos(angle), Math.sin(angle)), DT);
    events.push(...world.events.drain());
  }
  return events;
};

/** Drops a gem worth `value` XP where (x, z) is. */
const dropGem = (world: World, x: number, z: number, value: number) => {
  const k = world.gems.add();
  world.gems.fields.x[k] = x;
  world.gems.fields.z[k] = z;
  world.gems.fields.value[k] = value;
  world.gems.fields.magnet[k] = 0;
};

/** Adds one grunt at (x, z). */
const addEnemy = (world: World, x: number, z: number): number => {
  const i = world.enemies.add();
  const e = world.enemies.fields;
  e.x[i] = x;
  e.z[i] = z;
  e.hp[i] = 1000;
  e.type[i] = 0;
  e.hitFlash[i] = 0;
  return i;
};

const offersOpen = (world: World) =>
  world.heroes.map((hero) => hero.offer !== null);

/** Where an enemy exactly between heroes at x0 and x1 heads: -1 left, 1 right. */
const chase = (x0: number, x1: number) => {
  const world = createWorld({ content, heroIds: ["bolter", "bolter"] }, 4);
  world.heroes[0]!.x = x0;
  world.heroes[1]!.x = x1;
  const i = addEnemy(world, 0, 10);
  step(world, STILL, DT);
  return Math.sign(world.enemies.fields.x[i]!);
};

/** A two-hero world one step into a level-up: both heroes have an offer open. */
const levelUpForTwo = () => {
  const world = createWorld({ content, heroIds: ["bolter", "burner"] }, 9);
  const [a, b] = world.heroes;
  dropGem(world, a!.x, a!.z, 2);
  dropGem(world, b!.x, b!.z, 1);
  step(world, STILL, DT);
  return world;
};

describe("content", () => {
  it("reports ids that point at nothing", () => {
    expect(findBrokenReferences(content)).toStrictEqual([]);
    const broken = {
      ...content,
      waves: [{ from: 0, to: 1, enemy: "ghost", perSecond: 1 }] as const,
    };
    expect(findBrokenReferences(broken)).toStrictEqual([
      'wave 0-1s spawns unknown enemy "ghost"',
    ]);
  });
});

describe("simulation", () => {
  it("is deterministic for the same seed and inputs", () => {
    const a = createWorld({ content, heroIds: ["bolter"] }, 42);
    const b = createWorld({ content, heroIds: ["bolter"] }, 42);
    play(a, 60);
    play(b, 60);
    expect(a.kills).toBe(b.kills);
    expect(a.level).toBe(b.level);
    expect(a.heroes[0]!.hp).toBe(b.heroes[0]!.hp);
    expect(a.enemies.count).toBe(b.enemies.count);
  });

  it("spawns enemies, kills them, levels up, and reports each level-up", () => {
    const world = createWorld({ content, heroIds: ["burner"] }, 7);
    const events = play(world, 45);
    expect(world.enemies.count).toBeGreaterThan(0);
    expect(world.kills).toBeGreaterThan(0);
    expect(world.level).toBeGreaterThan(1);
    expect(events.filter((e) => e.type === "levelUp")).toHaveLength(
      world.level - 1
    );
  });

  it("freezes while an upgrade offer is open", () => {
    const world = createWorld({ content, heroIds: ["bolter"] }, 3);
    while (!world.heroes[0]!.offer && world.time < 60) {
      step(world, solo(0, 0), DT);
    }
    expect(world.heroes[0]!.offer).not.toBeNull();
    const { time } = world;
    step(world, solo(1, 0), DT);
    expect(world.time).toBe(time);
    expect(chooseUpgrade(world, 0, 0)).toBe(true);
    expect(world.heroes[0]!.offer).toBeNull();
  });

  it("reports runEnded once when the player dies", () => {
    const world = createWorld({ content, heroIds: ["bolter"] }, 1);
    world.heroes[0]!.hp = 0.0001;
    const events: SurvivorsEvent[] = [];
    for (let i = 0; i < 60 * 60 && world.status === "running"; i++) {
      if (world.heroes[0]!.offer) {
        chooseUpgrade(world, 0, 0);
      }
      step(world, solo(0, 0), DT);
      events.push(...world.events.drain());
    }
    expect(world.status).toBe("dead");
    const ended = events.filter((e) => e.type === "runEnded");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      summaries: [{ won: false, heroId: "bolter", heroName: "Bolter" }],
    });
  });

  it("reports a win when the timer runs out", () => {
    const world = createWorld({ content, heroIds: ["burner"] }, 5);
    world.time = content.rules.runLength - DT / 2;
    step(world, solo(0, 0), DT);
    expect(world.status).toBe("won");
    expect(
      world.events
        .drain()
        .some((e) => e.type === "runEnded" && e.summaries[0]!.won)
    ).toBe(true);
  });

  it("plays the same run whether picks come through modify or step input", () => {
    // The replay tests pick through modify; lockstep picks through step input. Same run either way.
    const sturdy = Schema.decodeUnknownSync(GameContent)({
      ...content,
      heroes: [{ ...content.heroes[0], maxHp: 1e9 }],
    });
    const run = (scheduled: boolean) => {
      const hashes: number[] = [];
      const loop = new GameLoop({
        ...survivorsSimulation,
        step: (world: World, input: SurvivorsInput, dt: number) => {
          survivorsSimulation.step(world, input, dt);
          hashes.push(hashWorld(world));
        },
      });
      loop.start({ content: sturdy, heroIds: ["bolter"] }, 77, 0);
      const world = loop.state!;
      const move: { -readonly [K in keyof HeroInput]: HeroInput[K] } = {
        moveX: 0,
        moveZ: 0,
      };
      const script: StepInput<HeroInput> = {
        read: (i) => {
          move.moveX = Math.cos(i / 150);
          move.moveZ = Math.sin(i / 150);
          const { offer } = world.heroes[0]!;
          if (scheduled && offer) {
            move.pick = {
              offer: world.offerSeq,
              index: Math.min(1, offer.length - 1),
            };
          } else {
            delete move.pick;
          }
          return move;
        },
      };
      const input = soloInput(script);
      for (let i = 0; i < 3600; i++) {
        const nowMs = (i * 1000) / 60;
        const { offer } = world.heroes[0]!;
        if (!scheduled && offer) {
          loop.modify(
            (w) => chooseUpgrade(w, 0, Math.min(1, offer.length - 1)),
            nowMs
          );
        }
        loop.frame(input, { steps: 1 }, nowMs);
      }
      return { hashes, level: world.level };
    };
    const modified = run(false);
    const scheduled = run(true);
    expect(modified.level).toBeGreaterThan(3);
    expect(scheduled.hashes).toStrictEqual(modified.hashes);
  });

  it("rejects a run with no heroes or more than four", () => {
    expect(() => createWorld({ content, heroIds: [] }, 1)).toThrow(RangeError);
    expect(() =>
      createWorld({ content, heroIds: ["bolter", "a", "b", "c", "d"] }, 1)
    ).toThrow(RangeError);
    expect(
      createWorld(
        { content, heroIds: ["bolter", "x", "y", "burner"] },
        1
      ).heroes.map((hero) => hero.def.id)
    ).toStrictEqual(["bolter", "bolter", "bolter", "burner"]);
  });
});

describe("co-op", () => {
  it("feeds one team XP pool from any hero's gems", () => {
    const world = createWorld({ content, heroIds: ["bolter", "burner"] }, 2);
    const [a, b] = world.heroes;
    dropGem(world, b!.x, b!.z, 1);
    step(world, STILL, DT);
    expect(world.xp).toBe(1);
    dropGem(world, a!.x, a!.z, 1);
    step(world, STILL, DT);
    expect([world.xp, world.level]).toStrictEqual([2, 1]);
  });

  it("offers every hero its own upgrades and stays frozen until all have picked", () => {
    const world = levelUpForTwo();
    const levelUps = world.events.drain().filter((e) => e.type === "levelUp");
    expect([world.level, world.offerSeq, offersOpen(world)]).toStrictEqual([
      2,
      1,
      [true, true],
    ]);
    expect(levelUps.map((e) => [e.hero, e.offer])).toStrictEqual([
      [0, 1],
      [1, 1],
    ]);
    const { time } = world;

    step(
      world,
      inputs({ moveX: 1, moveZ: 0, pick: { offer: 1, index: 0 } }),
      DT
    );
    expect([
      offersOpen(world),
      world.time,
      world.pendingLevelUps,
    ]).toStrictEqual([[false, true], time, 1]);

    step(
      world,
      inputs(null, { moveX: 0, moveZ: 0, pick: { offer: 1, index: 0 } }),
      DT
    );
    // The run resumes in the step that closed the last offer.
    expect([
      offersOpen(world),
      world.time,
      world.pendingLevelUps,
    ]).toStrictEqual([[false, false], time + DT, 0]);
  });

  it("ignores a pick that names another offer, or no choice", () => {
    const world = levelUpForTwo();
    const a = world.heroes[0]!;
    step(
      world,
      inputs({ moveX: 0, moveZ: 0, pick: { offer: 0, index: 0 } }),
      DT
    );
    step(
      world,
      inputs({ moveX: 0, moveZ: 0, pick: { offer: 1, index: 9 } }),
      DT
    );
    expect(a.offer).not.toBeNull();
    expect(chooseUpgrade(world, 0, 9)).toBe(false);
    expect(chooseUpgrade(world, 0, 0)).toBe(true);
    // A pick repeated after the offer closed does nothing more.
    const weapons = a.weapons.map((slot) => slot.level);
    const passives = [...a.passiveLevels];
    step(
      world,
      inputs({ moveX: 0, moveZ: 0, pick: { offer: 1, index: 0 } }),
      DT
    );
    expect(a.weapons.map((slot) => slot.level)).toStrictEqual(weapons);
    expect([...a.passiveLevels]).toStrictEqual(passives);
  });

  it("lets a leaving player's open offer go, and no longer chases its hero", () => {
    const world = levelUpForTwo();
    chooseUpgrade(world, 0, 0);
    world.events.drain();
    const { time } = world;
    const b = world.heroes[1]!;
    const i = addEnemy(world, b.x, b.z + 3);
    const x = world.enemies.fields.x[i]!;
    step(world, { heroes: [], leaving: [1] }, DT);
    expect([
      hudSample(world).heroes[1]!.status,
      offersOpen(world),
      world.pendingLevelUps,
      world.time,
    ]).toStrictEqual(["left", [false, false], 0, time + DT]);
    expect(world.events.drain()).toContainEqual({ type: "heroLeft", hero: 1 });
    // It heads for hero 0, toward -x, not straight down at the hero that left.
    expect(world.enemies.fields.x[i]!).toBeLessThan(x);
  });

  it("sends an enemy exactly between two heroes after the lower slot", () => {
    expect(chase(-2, 2)).toBe(-1);
    expect(chase(2, -2)).toBe(1);
  });

  it("spawns enemies around each playing hero in turn", () => {
    const busy = Schema.decodeUnknownSync(GameContent)({
      ...content,
      waves: [{ from: 0, to: 120, enemy: "grunt", perSecond: 600 }],
    });
    const world = createWorld(
      { content: busy, heroIds: ["bolter", "burner"] },
      6
    );
    world.heroes[0]!.x = -25;
    world.heroes[1]!.x = 25;
    step(world, STILL, DT);
    const sides = (from: number) =>
      [...world.enemies.fields.x.subarray(from, world.enemies.count)].map(
        Math.sign
      );
    const first = sides(0);
    expect(first.length).toBeGreaterThan(8);
    expect(first).toStrictEqual(first.map((_, k) => (k % 2 === 0 ? -1 : 1)));
    // Once hero 1 has left, every enemy spawns around hero 0.
    const before = world.enemies.count;
    step(world, { heroes: [], leaving: [1] }, DT);
    expect(new Set(sides(before))).toStrictEqual(new Set([-1]));
  });

  it("puts a hero down at 0 HP and ends the run once none is playing", () => {
    const world = createWorld({ content, heroIds: ["bolter", "burner"] }, 8);
    const [a, b] = world.heroes;
    b!.hp = 0;
    step(world, STILL, DT);
    expect([b!.status, world.status]).toStrictEqual(["down", "running"]);
    // A downed hero is offered no upgrades.
    dropGem(world, a!.x, a!.z, 3);
    step(world, STILL, DT);
    expect(offersOpen(world)).toStrictEqual([true, false]);
    chooseUpgrade(world, 0, 0);
    world.events.drain();
    a!.hp = 0;
    step(world, STILL, DT);
    expect(world.status).toBe("dead");
    const ended = world.events.drain().find((e) => e.type === "runEnded");
    expect(ended).toMatchObject({
      summaries: [
        { won: false, heroId: "bolter" },
        { won: false, heroId: "burner" },
      ],
    });
  });

  it("holds a co-op run paused while a playing hero's player pauses", () => {
    const world = createWorld({ content, heroIds: ["bolter", "burner"] }, 3);
    step(world, STILL, DT);
    const { time } = world;
    step(world, inputs(null, { moveX: 0, moveZ: 0, paused: true }), DT);
    expect(world.time).toBe(time);
    expect(hudSample(world).heroes.map((hero) => hero.paused)).toStrictEqual([
      false,
      true,
    ]);
    step(world, STILL, DT);
    expect(world.time).toBe(time + DT);
    // A downed hero's player can't hold the run.
    world.heroes[1]!.hp = 0;
    step(world, STILL, DT);
    step(world, inputs(null, { moveX: 0, moveZ: 0, paused: true }), DT);
    expect(world.time).toBe(time + 3 * DT);
  });
});
