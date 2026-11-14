import { EntityPool } from "arcadekit/core";
import type * as Game from "arcadekit/game";
import * as Scenario from "arcadekit/game/scenario";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ChooseUpgrade,
  HoldPause,
  NoSuchChoice,
  NotPlaying,
  OfferClosed,
} from "../src/commands";
import { HeroLeft, Hud, LeveledUp, RunEnded } from "../src/events";
import { hashWorld } from "../src/hash-world";
import type { HeroInput, SurvivorsInput } from "../src/input";
import { GameContent } from "../src/schema";
import { Survivors } from "../src/simulation";
import { choose, createWorld, hudSample, step } from "../src/world";
import type { World } from "../src/world";

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

/** Everything a survivors run reports: its events and its HUD sample. */
type SurvivorsEvent = Game.EventOf<typeof Survivors>;

const DT = 1 / 60;

/** A step's context for a test that calls `step` itself: its events go nowhere. */
const STEP = { dt: DT, step: 0, report: () => {} };

/** A step's context that keeps what the steps report, for a test that calls `step` itself. */
const collecting = () => {
  const events: SurvivorsEvent[] = [];
  const report = (event: SurvivorsEvent) => {
    events.push(event);
  };
  return { events, context: { dt: DT, step: 0, report } };
};

const STILL: SurvivorsInput = { players: [], leaving: [] };

/** One step's input: each player's, by its hero's slot. */
const inputs = (
  ...players: (HeroInput | null)[]
): { players: (HeroInput | null)[]; leaving: number[] } => ({
  players,
  leaving: [],
});

const solo = (moveX: number, moveZ: number): SurvivorsInput =>
  inputs({ moveX, moveZ });

/** Plays `seconds` of a run: walks in a slow circle and always takes the first upgrade. Returns all events. */
const play = (world: World, seconds: number): SurvivorsEvent[] => {
  const { events, context } = collecting();
  for (
    let frame = 0;
    frame < seconds * 60 && world.status === "running";
    frame++
  ) {
    const hero = world.heroes[0]!;
    if (hero.offer) {
      choose(world, hero, 0);
    }
    const angle = frame / 200;
    step(world, solo(Math.cos(angle), Math.sin(angle)), context);
  }
  return events;
};

/** Drops a gem worth `value` XP where (x, z) is. */
const dropGem = (world: World, x: number, z: number, value: number) => {
  const k = EntityPool.add(world.gems);
  world.gems.fields.x[k] = x;
  world.gems.fields.z[k] = z;
  world.gems.fields.value[k] = value;
};

/** Adds one grunt at (x, z). */
const addEnemy = (world: World, x: number, z: number): number => {
  const i = EntityPool.add(world.enemies);
  const e = world.enemies.fields;
  e.x[i] = x;
  e.z[i] = z;
  e.hp[i] = 1000;
  e.type[i] = 0;
  return i;
};

const offersOpen = (world: World) =>
  world.heroes.map((hero) => hero.offer !== null);

/** Where an enemy exactly between heroes at x0 and x1 heads: -1 left, 1 right. */
const chase = (x0: number, x1: number) => {
  const world = createWorld(
    { content, heroIds: ["bolter", "bolter"] },
    { seed: 4 }
  );
  world.heroes[0]!.x = x0;
  world.heroes[1]!.x = x1;
  const i = addEnemy(world, 0, 10);
  step(world, STILL, STEP);
  return Math.sign(world.enemies.fields.x[i]!);
};

/** A two-hero world one step into a level-up: both heroes have an offer open. */
const levelUpForTwo = (context: Game.StepContext<SurvivorsEvent> = STEP) => {
  const world = createWorld(
    { content, heroIds: ["bolter", "burner"] },
    { seed: 9 }
  );
  const [a, b] = world.heroes;
  dropGem(world, a!.x, a!.z, 2);
  dropGem(world, b!.x, b!.z, 1);
  step(world, STILL, context);
  return world;
};

/** Why `input` fails to decode as content, or "" if it decodes. */
const decodeFailure = (input: unknown): string => {
  try {
    Schema.decodeUnknownSync(GameContent)(input);
    return "";
  } catch (error) {
    return String(error);
  }
};

describe("content", () => {
  it("decodes the test content", () => {
    expect(decodeFailure(content)).toBe("");
  });

  it("rejects a wave that spawns an unknown enemy", () => {
    const broken = {
      ...content,
      waves: [{ from: 0, to: 1, enemy: "ghost", perSecond: 1 }],
    };
    expect(decodeFailure(broken)).toContain(
      'wave 0-1s spawns unknown enemy "ghost"'
    );
  });

  it("rejects a hero that starts with an unknown weapon", () => {
    const [bolter] = content.heroes;
    const broken = {
      ...content,
      heroes: [{ ...bolter, startingWeapon: "wand" }],
    };
    expect(decodeFailure(broken)).toContain(
      'hero "bolter" starts with unknown weapon "wand"'
    );
  });

  it("reports every broken reference at once", () => {
    const [bolter] = content.heroes;
    const message = decodeFailure({
      ...content,
      heroes: [{ ...bolter, startingWeapon: "wand" }],
      waves: [{ from: 0, to: 1, enemy: "ghost", perSecond: 1 }],
    });
    expect(message).toContain('unknown weapon "wand"');
    expect(message).toContain('unknown enemy "ghost"');
  });

  it("rejects a fractional enemy cap", () => {
    const broken = { ...content, rules: { ...content.rules, maxEnemies: 2.5 } };
    expect(decodeFailure(broken)).toContain("maxEnemies");
  });

  it("rejects a fractional number of upgrades to offer", () => {
    // The roll draws once for each upgrade it offers, so half a draw is no offer: content
    // that asks for one is refused when it loads, not at a hero's first level-up.
    const broken = {
      ...content,
      rules: { ...content.rules, choicesPerLevelUp: 2.5 },
    };
    expect(decodeFailure(broken)).toContain("choicesPerLevelUp");
  });
});

describe("simulation", () => {
  it("is deterministic for the same seed and inputs", () => {
    const a = createWorld({ content, heroIds: ["bolter"] }, { seed: 42 });
    const b = createWorld({ content, heroIds: ["bolter"] }, { seed: 42 });
    play(a, 60);
    play(b, 60);
    expect(a.kills).toBe(b.kills);
    expect(a.level).toBe(b.level);
    expect(a.heroes[0]!.hp).toBe(b.heroes[0]!.hp);
    expect(a.enemies.count).toBe(b.enemies.count);
  });

  it("spawns enemies, kills them, levels up, and reports each level-up", () => {
    const world = createWorld({ content, heroIds: ["burner"] }, { seed: 7 });
    const events = play(world, 45);
    expect(world.enemies.count).toBeGreaterThan(0);
    expect(world.kills).toBeGreaterThan(0);
    expect(world.level).toBeGreaterThan(1);
    expect(events.filter((e) => e._tag === "LeveledUp")).toHaveLength(
      world.level - 1
    );
  });

  it("freezes while an upgrade offer is open", () => {
    const world = createWorld({ content, heroIds: ["bolter"] }, { seed: 3 });
    while (!world.heroes[0]!.offer && world.time < 60) {
      step(world, solo(0, 0), STEP);
    }
    expect(world.heroes[0]!.offer).not.toBeNull();
    const { time } = world;
    step(world, solo(1, 0), STEP);
    expect(world.time).toBe(time);
    expect(choose(world, world.heroes[0]!, 0)).toBe(true);
    expect(world.heroes[0]!.offer).toBeNull();
  });

  it("reports RunEnded once when the player dies", () => {
    const world = createWorld({ content, heroIds: ["bolter"] }, { seed: 1 });
    const hero = world.heroes[0]!;
    hero.hp = 0.0001;
    const { events, context } = collecting();
    for (let i = 0; i < 60 * 60 && world.status === "running"; i++) {
      if (hero.offer) {
        choose(world, hero, 0);
      }
      step(world, solo(0, 0), context);
    }
    expect(world.status).toBe("dead");
    const ended = events.filter((e) => e._tag === "RunEnded");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      summaries: [{ won: false, heroId: "bolter", heroName: "Bolter" }],
    });
  });

  it("rejects a run with no heroes or more than four", () => {
    expect(() => createWorld({ content, heroIds: [] }, { seed: 1 })).toThrow(
      RangeError
    );
    expect(() =>
      createWorld(
        { content, heroIds: ["bolter", "a", "b", "c", "d"] },
        { seed: 1 }
      )
    ).toThrow(RangeError);
    expect(
      createWorld(
        { content, heroIds: ["bolter", "x", "y", "burner"] },
        { seed: 1 }
      ).heroes.map((hero) => hero.def.id)
    ).toStrictEqual(["bolter", "bolter", "bolter", "burner"]);
  });
});

/** The test content with a wide enemy: its radius is more than a cell of the horde's grid, which is 2 wide. */
const wideEnemy = Schema.decodeUnknownSync(GameContent)({
  ...content,
  enemies: [{ ...content.enemies[0], radius: 2.5 }],
});

/** A burner at the centre whose aura fires on its first step. */
const burnerReady = (): World => {
  const world = createWorld(
    { content: wideEnemy, heroIds: ["burner"] },
    { seed: 5 }
  );
  world.heroes[0]!.weapons[0]!.timer = 0;
  return world;
};

/** A bolter at the centre whose bolt is at `level` and fires on its first step. */
const bolterReady = (level: number): World => {
  const world = createWorld({ content, heroIds: ["bolter"] }, { seed: 5 });
  const [slot] = world.heroes[0]!.weapons;
  slot!.level = level;
  slot!.timer = 0;
  return world;
};

/** Adds a projectile at rest at (x, z), which hits for 1 and is spent by its first hit. */
const addProjectile = (world: World, x: number, z: number): number => {
  const i = EntityPool.add(world.projectiles);
  const pr = world.projectiles.fields;
  pr.x[i] = x;
  pr.z[i] = z;
  pr.vx[i] = 0;
  pr.vz[i] = 0;
  pr.damage[i] = 1;
  pr.life[i] = 1;
  pr.pierce[i] = 0;
  pr.weapon[i] = 0;
  return i;
};

/** Where each projectile heads on the x axis: -1 left, 1 right. */
const headings = (world: World): number[] =>
  [...world.projectiles.fields.vx.subarray(0, world.projectiles.count)].map(
    Math.sign
  );

describe("the horde's circles", () => {
  it("hurt a hero that a wide enemy overlaps, though its centre is cells away", () => {
    const world = burnerReady();
    const [hero] = world.heroes;
    // 2.8 from a hero of radius 0.5: the two overlap, and the enemy's centre is in the cell
    // past the ones the hero's own circle is in.
    addEnemy(world, 2.8, 0);
    step(world, STILL, STEP);
    expect(hero!.hp).toBeLessThan(hero!.maxHp);
    expect([...world.cues.hurt]).toStrictEqual([1]);
  });

  it("each hurt a hero they overlap, and it cries out once", () => {
    const world = createWorld({ content, heroIds: ["bolter"] }, { seed: 5 });
    const [hero] = world.heroes;
    // One on each side, each well inside the 0.95 at which a grunt and a hero touch.
    addEnemy(world, 0.5, 0);
    addEnemy(world, -0.5, 0);
    step(world, STILL, STEP);
    // A grunt's damage is 10 a second, and both dealt a step of it.
    expect(hero!.hp).toBeCloseTo(hero!.maxHp - 2 * 10 * DT, 9);
    expect([...world.cues.hurt]).toStrictEqual([1]);
  });

  it("leave a hero alone that no enemy overlaps", () => {
    const world = burnerReady();
    const [hero] = world.heroes;
    addEnemy(world, 3.2, 0);
    step(world, STILL, STEP);
    expect(hero!.hp).toBe(hero!.maxHp);
    expect([...world.cues.hurt]).toStrictEqual([0]);
  });

  it("are hit by an aura that overlaps them, and by no other", () => {
    const world = burnerReady();
    // The aura's radius is 2.6, so it reaches a wide enemy's edge to 5.1 from the hero.
    const near = addEnemy(world, 0, 4.9);
    const far = addEnemy(world, 0, -5.5);
    step(world, STILL, STEP);
    expect(world.enemies.fields.hp[near]!).toBeLessThan(1000);
    expect(world.enemies.fields.hp[far]!).toBe(1000);
  });

  it("are hit by a projectile that overlaps them, and passed by one that only touches", () => {
    const round = Schema.decodeUnknownSync(GameContent)({
      ...content,
      enemies: [{ ...content.enemies[0], radius: 0.5 }],
    });
    const world = createWorld(
      { content: round, heroIds: ["bolter"] },
      { seed: 5 }
    );
    // An enemy on its hero has nowhere to go, so it stays at the centre and the lengths are
    // exact: a projectile's radius is 0.25, so one 0.75 away only touches it.
    const enemy = addEnemy(world, 0, 0);
    addProjectile(world, 0.75, 0);
    addProjectile(world, 0, -0.5);
    step(world, STILL, STEP);
    expect(world.cues.hits).toBe(1);
    expect(world.enemies.fields.hp[enemy]!).toBe(999);
    // The one that hit is spent; the other flies on.
    expect([
      world.projectiles.count,
      world.projectiles.fields.x[0],
    ]).toStrictEqual([1, 0.75]);
  });

  it("are passed by a projectile once dead, which hits the living one it also overlaps", () => {
    const world = createWorld({ content, heroIds: ["bolter"] }, { seed: 5 });
    // Both in one cell of the grid, whose list starts with the one added last: the dead one,
    // killed earlier in the step as an aura would, and not yet removed.
    const living = addEnemy(world, 4.5, 0);
    const dead = addEnemy(world, 5.5, 0);
    world.enemies.fields.hp[dead] = 0;
    // Half a unit from each, give or take their step toward the hero: under 0.25 + 0.45.
    addProjectile(world, 5, 0);
    step(world, STILL, STEP);
    expect(world.cues.hits).toBe(1);
    // The dead one is removed at the end of the step, and it was last in the pool.
    expect([world.enemies.count, world.kills]).toStrictEqual([1, 1]);
    expect(world.enemies.fields.hp[living]!).toBe(999);
    expect(world.projectiles.count).toBe(0);
  });
});

describe("a bolt", () => {
  it("aims one shot at each of the nearest enemies in range", () => {
    // Level 3 fires two shots.
    const world = bolterReady(3);
    addEnemy(world, 6, 0);
    addEnemy(world, -5, 0);
    addEnemy(world, 4, 0);
    step(world, STILL, STEP);
    // The nearest first, at 4 to the right, then the one at 5 to the left.
    expect(headings(world)).toStrictEqual([1, -1]);
  });

  it("aims every shot at the one enemy in range", () => {
    const world = bolterReady(3);
    addEnemy(world, -4, 0);
    addEnemy(world, 20, 0);
    step(world, STILL, STEP);
    expect(headings(world)).toStrictEqual([-1, -1]);
  });

  it("stays unfired with no enemy in range", () => {
    const world = bolterReady(3);
    addEnemy(world, 20, 0);
    step(world, STILL, STEP);
    expect(world.projectiles.count).toBe(0);
  });

  it("aims at the lower index of two enemies at one distance", () => {
    const right = bolterReady(1);
    addEnemy(right, 5, 0);
    addEnemy(right, -5, 0);
    step(right, STILL, STEP);
    expect(headings(right)).toStrictEqual([1]);

    const left = bolterReady(1);
    addEnemy(left, -5, 0);
    addEnemy(left, 5, 0);
    step(left, STILL, STEP);
    expect(headings(left)).toStrictEqual([-1]);
  });

  it("leaves its targets free for the next bolt", () => {
    const world = createWorld(
      { content, heroIds: ["bolter", "bolter"] },
      { seed: 5 }
    );
    for (const hero of world.heroes) {
      hero.weapons[0]!.timer = 0;
    }
    addEnemy(world, 0, 6);
    step(world, STILL, STEP);
    // Both heroes fired at the one enemy.
    expect(world.projectiles.count).toBe(2);
    expect([...world.taken].every((taken) => taken === 0)).toBe(true);
  });
});

// What a run reports, and which picks its rules take and refuse, are told as scenarios: given a
// run, after these steps and commands, it reported this and refused that. The tests above and
// below arrange a state by hand, which a scenario can't, so they call `step` themselves.
const scenario = Scenario.make(Survivors);

/** The run's clock after `steps` steps: the sum the steps themselves make. */
const clockAfter = (steps: number) => {
  let time = 0;
  for (let i = 0; i < steps; i++) {
    time += DT;
  }
  return time;
};

/** A run that is won on its fourth step, before anything spawns. */
const brief = Schema.decodeUnknownSync(GameContent)({
  ...content,
  rules: { ...content.rules, runLength: clockAfter(4) },
});

/**
 * Content whose offers are known whatever the Rng draws: one weapon and no passive, so a hero is
 * offered that weapon's next level and nothing else. The first kill is a level, the next level is
 * out of reach, and nobody dies.
 */
const oneChoice = Schema.decodeUnknownSync(GameContent)({
  ...content,
  rules: { ...content.rules, xpToLevel2: 1, xpGrowth: 1000 },
  heroes: [{ ...content.heroes[1], maxHp: 1e9 }],
  weapons: [content.weapons[1]],
  passives: [],
});
const AURA_2 = {
  kind: "weapon",
  id: "aura",
  name: "Aura",
  description: "Stronger and faster.",
  level: 2,
} as const;

/** Long enough for the first grunt to walk into an aura and die. The run freezes at the offer, so the rest changes nothing. */
const UNTIL_LEVEL_UP = 20 * 60;

describe("what a run reports", () => {
  it("reports RunEnded when the timer runs out, then samples the HUD", () => {
    const time = clockAfter(4);
    scenario(
      Scenario.given({ content: brief, heroIds: ["burner"] }),
      Scenario.step(STILL, 3),
      Scenario.reported(),
      Scenario.step(STILL),
      Scenario.reported(
        new RunEnded({
          summaries: [
            {
              won: true,
              heroId: "burner",
              heroName: "Burner",
              time,
              kills: 0,
              level: 1,
            },
          ],
        })
      ),
      // Read right after the frame that ended the run, not at the HUD's next 100 ms.
      Scenario.sampled(
        new Hud({
          level: 1,
          xp: 0,
          xpNext: 3,
          time,
          runLength: time,
          kills: 0,
          enemies: 0,
          heroes: [
            {
              heroId: "burner",
              hp: 120,
              maxHp: 120,
              status: "playing",
              paused: false,
              choosing: false,
            },
          ],
        })
      ),
      // A run that is over does nothing more.
      Scenario.step(STILL, 60),
      Scenario.reported(),
      Scenario.state((world) => {
        expect([world.status, world.time]).toStrictEqual(["won", time]);
      })
    );
  });

  it("reports HeroLeft when a player leaves, once", () => {
    scenario(
      Scenario.given({ content, heroIds: ["bolter", "burner"] }),
      Scenario.step({ players: [], leaving: [1] }),
      Scenario.reported(new HeroLeft({ hero: 1 })),
      Scenario.step({ players: [], leaving: [1] }),
      Scenario.reported()
    );
  });

  it("reports one LeveledUp for each playing hero, and nothing more until they pick", () => {
    scenario(
      Scenario.given({
        content: oneChoice,
        heroIds: ["burner", "burner", "burner"],
      }),
      Scenario.step({ players: [], leaving: [2] }),
      Scenario.reported(new HeroLeft({ hero: 2 })),
      Scenario.step(STILL, UNTIL_LEVEL_UP),
      Scenario.reported(
        new LeveledUp({ hero: 0, offer: 1, choices: [AURA_2] }),
        new LeveledUp({ hero: 1, offer: 1, choices: [AURA_2] })
      ),
      Scenario.state((world) => {
        expect(offersOpen(world)).toStrictEqual([true, true, false]);
      })
    );
  });
});

/** A one-hero run played until its hero is offered an upgrade: offer 1, with one choice. */
const OFFERED = [
  Scenario.given({ content: oneChoice, heroIds: ["burner"] }),
  Scenario.step(STILL, UNTIL_LEVEL_UP),
  Scenario.reported(new LeveledUp({ hero: 0, offer: 1, choices: [AURA_2] })),
];

/** The same for two heroes: each has offer 1 open. */
const OFFERED_TO_TWO = [
  Scenario.given({ content: oneChoice, heroIds: ["burner", "burner"] }),
  Scenario.step(STILL, UNTIL_LEVEL_UP),
  Scenario.reported(
    new LeveledUp({ hero: 0, offer: 1, choices: [AURA_2] }),
    new LeveledUp({ hero: 1, offer: 1, choices: [AURA_2] })
  ),
];

/** Each hero's first weapon's level: 2 once it took the one choice. */
const weaponLevels = (world: World) =>
  world.heroes.map((hero) => hero.weapons[0]!.level);

describe("an upgrade pick", () => {
  it("gives the sender's hero its choice, closes the offer and resumes the run in that step", () => {
    let frozenAt = 0;
    scenario(
      OFFERED,
      Scenario.state((world) => {
        frozenAt = world.time;
      }),
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 })),
      Scenario.step(STILL),
      Scenario.refused(),
      Scenario.reported(),
      Scenario.state((world) => {
        expect({
          weapons: weaponLevels(world),
          open: offersOpen(world),
          pending: world.pendingLevelUps,
          time: world.time,
        }).toStrictEqual({
          weapons: [2],
          open: [false],
          pending: 0,
          time: frozenAt + DT,
        });
      })
    );
  });

  it("is its sender's: the run stays frozen until every hero has picked", () => {
    let frozenAt = 0;
    scenario(
      OFFERED_TO_TWO,
      Scenario.state((world) => {
        frozenAt = world.time;
      }),
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 }), 1),
      Scenario.step(STILL),
      Scenario.state((world) => {
        expect([
          weaponLevels(world),
          offersOpen(world),
          world.time,
        ]).toStrictEqual([[1, 2], [true, false], frozenAt]);
      }),
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 })),
      Scenario.step(STILL),
      Scenario.state((world) => {
        expect([
          weaponLevels(world),
          offersOpen(world),
          world.time,
        ]).toStrictEqual([[2, 2], [false, false], frozenAt + DT]);
      })
    );
  });

  it("is refused when it names another offer than the open one", () => {
    scenario(
      OFFERED,
      Scenario.send(new ChooseUpgrade({ offer: 0, index: 0 })),
      Scenario.send(new ChooseUpgrade({ offer: 2, index: 0 })),
      Scenario.step(STILL),
      Scenario.refused(
        new OfferClosed({ offer: 0 }),
        new OfferClosed({ offer: 2 })
      ),
      Scenario.state((world) => {
        expect([weaponLevels(world), offersOpen(world)]).toStrictEqual([
          [1],
          [true],
        ]);
      })
    );
  });

  it("is refused when the offer has no such choice", () => {
    scenario(
      OFFERED,
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 1 })),
      Scenario.send(new ChooseUpgrade({ offer: 1, index: -1 })),
      Scenario.step(STILL),
      Scenario.refused(
        new NoSuchChoice({ offer: 1, index: 1 }),
        new NoSuchChoice({ offer: 1, index: -1 })
      ),
      Scenario.state((world) => {
        expect([weaponLevels(world), offersOpen(world)]).toStrictEqual([
          [1],
          [true],
        ]);
      })
    );
  });

  it("is refused when repeated: the first one closed the offer", () => {
    scenario(
      OFFERED,
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 })),
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 })),
      Scenario.step(STILL),
      Scenario.refused(new OfferClosed({ offer: 1 })),
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 })),
      Scenario.step(STILL),
      Scenario.refused(new OfferClosed({ offer: 1 })),
      Scenario.state((world) => {
        expect(weaponLevels(world)).toStrictEqual([2]);
      })
    );
  });

  it("is refused with no offer open, and from a slot with no hero", () => {
    scenario(
      Scenario.given({ content: oneChoice, heroIds: ["burner"] }),
      // No offer has been made yet, though the offers' number is still 0.
      Scenario.send(new ChooseUpgrade({ offer: 0, index: 0 })),
      Scenario.send(new ChooseUpgrade({ offer: 0, index: 0 }), 3),
      Scenario.step(STILL),
      Scenario.refused(
        new OfferClosed({ offer: 0 }),
        new OfferClosed({ offer: 0 })
      )
    );
  });

  it("changes nothing in the world when it is refused", () => {
    let before = 0;
    scenario(
      OFFERED_TO_TWO,
      Scenario.state((world) => {
        before = hashWorld(world);
      }),
      Scenario.send(new ChooseUpgrade({ offer: 2, index: 0 })),
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 5 }), 1),
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 }), 2),
      Scenario.step(STILL),
      Scenario.refused(
        new OfferClosed({ offer: 2 }),
        new NoSuchChoice({ offer: 1, index: 5 }),
        new OfferClosed({ offer: 1 })
      ),
      Scenario.state((world) => {
        expect(hashWorld(world)).toBe(before);
      })
    );
  });
});

/** Who is choosing as the HUD tells it: what a co-op app shows ("waiting for X to pick"). */
const choosing = (shown: World) =>
  hudSample(shown).heroes.map((hero) => hero.choosing);

describe("co-op", () => {
  it("feeds one team XP pool from any hero's gems", () => {
    const world = createWorld(
      { content, heroIds: ["bolter", "burner"] },
      { seed: 2 }
    );
    const [a, b] = world.heroes;
    dropGem(world, b!.x, b!.z, 1);
    step(world, STILL, STEP);
    expect(world.xp).toBe(1);
    dropGem(world, a!.x, a!.z, 1);
    step(world, STILL, STEP);
    expect([world.xp, world.level]).toStrictEqual([2, 1]);
  });

  it("offers every hero its own upgrades and stays frozen until all have picked", () => {
    const { events, context } = collecting();
    const world = levelUpForTwo(context);
    const levelUps = events.filter((e) => e._tag === "LeveledUp");
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

    choose(world, world.heroes[0]!, 0);
    step(world, inputs({ moveX: 1, moveZ: 0 }), STEP);
    expect([
      offersOpen(world),
      world.time,
      world.pendingLevelUps,
    ]).toStrictEqual([[false, true], time, 1]);

    choose(world, world.heroes[1]!, 0);
    step(world, STILL, STEP);
    // The run resumes in the step after the pick that closed the last offer.
    expect([
      offersOpen(world),
      world.time,
      world.pendingLevelUps,
    ]).toStrictEqual([[false, false], time + DT, 0]);
  });

  it("says in the HUD which heroes the run waits on to pick, while each has its offer open", () => {
    const before = choosing(
      createWorld({ content, heroIds: ["bolter", "burner"] }, { seed: 9 })
    );
    const world = levelUpForTwo();
    const open = choosing(world);
    choose(world, world.heroes[0]!, 0);
    step(world, STILL, STEP);
    const afterOnePick = choosing(world);
    // The other hero's offer closes without a pick when its player leaves.
    step(world, { players: [null, null], leaving: [1] }, STEP);
    expect({
      before,
      open,
      afterOnePick,
      afterLeaving: choosing(world),
    }).toStrictEqual({
      before: [false, false],
      open: [true, true],
      afterOnePick: [false, true],
      afterLeaving: [false, false],
    });
  });

  it("takes a choice its hero's open offer has, once, and no other", () => {
    const world = levelUpForTwo();
    const a = world.heroes[0]!;
    expect(choose(world, a, 9)).toBe(false);
    expect(a.offer).not.toBeNull();
    expect(choose(world, a, 0)).toBe(true);
    // Repeated after the offer closed, it does nothing more.
    const weapons = a.weapons.map((slot) => slot.level);
    const passives = [...a.passiveLevels];
    expect(choose(world, a, 0)).toBe(false);
    expect([
      a.weapons.map((slot) => slot.level),
      [...a.passiveLevels],
    ]).toStrictEqual([weapons, passives]);
  });

  it("lets a leaving player's open offer go, and no longer chases its hero", () => {
    const world = levelUpForTwo();
    choose(world, world.heroes[0]!, 0);
    const { time } = world;
    const b = world.heroes[1]!;
    const i = addEnemy(world, b.x, b.z + 3);
    const x = world.enemies.fields.x[i]!;
    const { events, context } = collecting();
    step(world, { players: [], leaving: [1] }, context);
    expect([
      hudSample(world).heroes[1]!.status,
      offersOpen(world),
      world.pendingLevelUps,
      world.time,
    ]).toStrictEqual(["left", [false, false], 0, time + DT]);
    expect(events).toStrictEqual([new HeroLeft({ hero: 1 })]);
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
      { seed: 6 }
    );
    world.heroes[0]!.x = -25;
    world.heroes[1]!.x = 25;
    step(world, STILL, STEP);
    const sides = (from: number) =>
      [...world.enemies.fields.x.subarray(from, world.enemies.count)].map(
        Math.sign
      );
    const first = sides(0);
    expect(first.length).toBeGreaterThan(8);
    expect(first).toStrictEqual(first.map((_, k) => (k % 2 === 0 ? -1 : 1)));
    // Once hero 1 has left, every enemy spawns around hero 0.
    const before = world.enemies.count;
    step(world, { players: [], leaving: [1] }, STEP);
    expect(new Set(sides(before))).toStrictEqual(new Set([-1]));
  });

  it("puts a hero down at 0 HP and ends the run once none is playing", () => {
    const world = createWorld(
      { content, heroIds: ["bolter", "burner"] },
      { seed: 8 }
    );
    const [a, b] = world.heroes;
    b!.hp = 0;
    step(world, STILL, STEP);
    expect([b!.status, world.status]).toStrictEqual(["down", "running"]);
    // A downed hero is offered no upgrades.
    dropGem(world, a!.x, a!.z, 3);
    step(world, STILL, STEP);
    expect(offersOpen(world)).toStrictEqual([true, false]);
    choose(world, a!, 0);
    a!.hp = 0;
    const { events, context } = collecting();
    step(world, STILL, context);
    expect(world.status).toBe("dead");
    const ended = events.find((e) => e._tag === "RunEnded");
    expect(ended).toMatchObject({
      summaries: [
        { won: false, heroId: "bolter" },
        { won: false, heroId: "burner" },
      ],
    });
  });
});

/**
 * Content in which the second hero is sure to go down and the first is not: the horde can't be
 * killed, so it reaches both, and the second hero has hardly a hit point. Nobody levels up.
 */
const deadly = Schema.decodeUnknownSync(GameContent)({
  ...content,
  heroes: [
    { ...content.heroes[0], maxHp: 1e9 },
    { ...content.heroes[1], maxHp: 1 },
  ],
  enemies: [{ ...content.enemies[0], hp: 1e9 }],
});

/** Long enough for the horde to reach the heroes. */
const UNTIL_TOUCHED = 20 * 60;

const statuses = (world: World) => world.heroes.map((hero) => hero.status);

const pauses = (world: World) => world.heroes.map((hero) => hero.paused);

/** Who holds the run paused as the HUD tells it: what an app shows ("Paused by ..."). */
const pausesShown = (world: World) =>
  hudSample(world).heroes.map((hero) => hero.paused);

describe("the co-op pause", () => {
  it("freezes the run for everyone while a playing hero holds it, and the run plays on in the step that lets go", () => {
    let time = 0;
    scenario(
      Scenario.given({ content, heroIds: ["bolter", "burner"] }),
      Scenario.step(STILL),
      Scenario.state((world) => {
        ({ time } = world);
      }),
      Scenario.send(new HoldPause({ held: true }), 1),
      Scenario.step(STILL, 60),
      Scenario.state((world) => {
        expect([pauses(world), pausesShown(world), world.time]).toStrictEqual([
          [false, true],
          [false, true],
          time,
        ]);
      }),
      // The other hero's letting go lets go of nothing: each hero holds its own.
      Scenario.send(new HoldPause({ held: false })),
      Scenario.step(STILL),
      Scenario.state((world) => {
        expect([pauses(world), world.time]).toStrictEqual([
          [false, true],
          time,
        ]);
      }),
      Scenario.send(new HoldPause({ held: false }), 1),
      Scenario.step(STILL),
      Scenario.refused(),
      Scenario.state((world) => {
        expect([pauses(world), pausesShown(world), world.time]).toStrictEqual([
          [false, false],
          [false, false],
          time + DT,
        ]);
      })
    );
  });

  it("keeps the hero that holds it from going down, and is refused from a hero that is down", () => {
    let time = 0;
    scenario(
      Scenario.given({ content: deadly, heroIds: ["bolter", "burner"] }),
      // Held from the start: nothing moves, so nothing reaches the frail hero.
      Scenario.send(new HoldPause({ held: true }), 1),
      Scenario.step(STILL, UNTIL_TOUCHED),
      Scenario.state((world) => {
        expect([statuses(world), world.time]).toStrictEqual([
          ["playing", "playing"],
          0,
        ]);
      }),
      // Let go, the horde comes: the hero is down, and holds nothing.
      Scenario.send(new HoldPause({ held: false }), 1),
      Scenario.step(STILL, UNTIL_TOUCHED),
      Scenario.state((world) => {
        ({ time } = world);
        expect([statuses(world), pauses(world)]).toStrictEqual([
          ["playing", "down"],
          [false, false],
        ]);
      }),
      // Its player can't hold the run any more: the hold is refused and nothing is held.
      Scenario.send(new HoldPause({ held: true }), 1),
      Scenario.step(STILL),
      Scenario.refused(new NotPlaying()),
      Scenario.state((world) => {
        expect([pauses(world), world.time]).toStrictEqual([
          [false, false],
          time + DT,
        ]);
      }),
      // Nor can it let go of what it doesn't hold.
      Scenario.send(new HoldPause({ held: false }), 1),
      Scenario.step(STILL),
      Scenario.refused(new NotPlaying()),
      Scenario.state((world) => {
        expect([pauses(world), world.time]).toStrictEqual([
          [false, false],
          time + DT + DT,
        ]);
      })
    );
  });

  it("is let go when the hero that holds it leaves, and the run plays on in that step", () => {
    let time = 0;
    scenario(
      Scenario.given({ content, heroIds: ["bolter", "burner"] }),
      Scenario.step(STILL),
      Scenario.state((world) => {
        ({ time } = world);
      }),
      Scenario.send(new HoldPause({ held: true }), 1),
      Scenario.step(STILL, 60),
      Scenario.step({ players: [], leaving: [1] }),
      Scenario.reported(new HeroLeft({ hero: 1 })),
      Scenario.state((world) => {
        expect([statuses(world), pauses(world), world.time]).toStrictEqual([
          ["playing", "left"],
          [false, false],
          time + DT,
        ]);
      }),
      // A hero that has left holds nothing, and neither does a slot with no hero.
      Scenario.send(new HoldPause({ held: true }), 1),
      Scenario.send(new HoldPause({ held: true }), 5),
      Scenario.step(STILL),
      Scenario.refused(new NotPlaying(), new NotPlaying()),
      Scenario.state((world) => {
        expect([pauses(world), world.time]).toStrictEqual([
          [false, false],
          time + 2 * DT,
        ]);
      })
    );
  });

  it("is taken while an offer is open, and holds the run once every hero has picked", () => {
    let time = 0;
    scenario(
      OFFERED_TO_TWO,
      Scenario.state((world) => {
        ({ time } = world);
      }),
      // The offer has the run frozen already. The hero is playing, so its hold is taken, and
      // shows at once.
      Scenario.send(new HoldPause({ held: true }), 1),
      Scenario.step(STILL),
      Scenario.refused(),
      Scenario.state((world) => {
        expect([pauses(world), offersOpen(world)]).toStrictEqual([
          [false, true],
          [true, true],
        ]);
      }),
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 })),
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 }), 1),
      Scenario.step(STILL, 60),
      Scenario.state((world) => {
        expect([offersOpen(world), world.time]).toStrictEqual([
          [false, false],
          time,
        ]);
      }),
      Scenario.send(new HoldPause({ held: false }), 1),
      Scenario.step(STILL),
      Scenario.state((world) => {
        expect(world.time).toBe(time + DT);
      })
    );
  });

  it("changes nothing in the world when it is refused", () => {
    let before = 0;
    scenario(
      Scenario.given({ content: deadly, heroIds: ["bolter", "burner"] }),
      Scenario.step(STILL, UNTIL_TOUCHED),
      // The hero that is still playing holds the run, so a step by itself changes nothing.
      Scenario.send(new HoldPause({ held: true })),
      Scenario.step(STILL),
      Scenario.state((world) => {
        expect([statuses(world), pauses(world)]).toStrictEqual([
          ["playing", "down"],
          [true, false],
        ]);
        before = hashWorld(world);
      }),
      Scenario.send(new HoldPause({ held: true }), 1),
      Scenario.step(STILL),
      Scenario.refused(new NotPlaying()),
      Scenario.state((world) => {
        expect(hashWorld(world)).toBe(before);
      }),
      Scenario.send(new HoldPause({ held: false }), 1),
      Scenario.send(new HoldPause({ held: true }), 5),
      Scenario.step(STILL),
      Scenario.refused(new NotPlaying(), new NotPlaying()),
      Scenario.state((world) => {
        expect(hashWorld(world)).toBe(before);
      })
    );
  });

  it("is let go when its hero leaves last, so the run ends holding none", () => {
    // The run's clock after its one step that plays.
    const time = DT;
    scenario(
      Scenario.given({ content, heroIds: ["bolter", "burner"] }),
      Scenario.step(STILL),
      Scenario.send(new HoldPause({ held: true }), 1),
      // The other hero leaves under the pause: the run stands, held by the one still playing.
      Scenario.step({ players: [], leaving: [0] }),
      Scenario.reported(new HeroLeft({ hero: 0 })),
      Scenario.state((world) => {
        expect([world.status, pauses(world), world.time]).toStrictEqual([
          "running",
          [false, true],
          time,
        ]);
      }),
      Scenario.step({ players: [], leaving: [1] }),
      Scenario.reported(
        new HeroLeft({ hero: 1 }),
        new RunEnded({
          summaries: [content.heroes[0]!, content.heroes[1]!].map((hero) => ({
            won: false,
            heroId: hero.id,
            heroName: hero.name,
            time,
            kills: 0,
            level: 1,
          })),
        })
      ),
      Scenario.state((world) => {
        expect([world.status, pauses(world), pausesShown(world)]).toStrictEqual(
          ["dead", [false, false], [false, false]]
        );
      })
    );
  });

  it("is refused once the run is over: a finished run holds no pause, and stays as it ended", () => {
    let ended = 0;
    scenario(
      Scenario.given({ content: brief, heroIds: ["bolter", "burner"] }),
      Scenario.step(STILL, 4),
      Scenario.reported(
        new RunEnded({
          summaries: [content.heroes[0]!, content.heroes[1]!].map((hero) => ({
            won: true,
            heroId: hero.id,
            heroName: hero.name,
            time: clockAfter(4),
            kills: 0,
            level: 1,
          })),
        })
      ),
      Scenario.state((world) => {
        // The heroes of a run that was won are still "playing": the run's end is what refuses.
        expect([world.status, statuses(world)]).toStrictEqual([
          "won",
          ["playing", "playing"],
        ]);
        ended = hashWorld(world);
      }),
      Scenario.send(new HoldPause({ held: true }), 1),
      Scenario.send(new HoldPause({ held: false })),
      Scenario.step(STILL),
      Scenario.refused(new NotPlaying(), new NotPlaying()),
      Scenario.state((world) => {
        expect([
          pauses(world),
          pausesShown(world),
          hashWorld(world),
        ]).toStrictEqual([[false, false], [false, false], ended]);
      })
    );
  });
});

// A step's commands are applied before the step, and a step handles its leavers first. So when
// a pick and a player's leaving come in one step, the pick is taken before the hero leaves.
/** A scenario step, `now`, that reads the run's hash and clock into `read`. */
const reading = () => {
  const read = { hash: 0, time: 0 };
  const now = Scenario.state((world: World) => {
    read.hash = hashWorld(world);
    read.time = world.time;
  });
  return { read, now };
};

describe("a pick and a leave in one step", () => {
  it.each([
    { picker: 0, leaver: 1 },
    { picker: 1, leaver: 0 },
  ])(
    "give the run that the leave and then the pick give, when hero $picker picks and hero $leaver leaves",
    ({ picker, leaver }) => {
      const pick = Scenario.send(
        new ChooseUpgrade({ offer: 1, index: 0 }),
        picker
      );
      const leave = Scenario.step({ players: [], leaving: [leaver] });
      const left = Scenario.reported(new HeroLeft({ hero: leaver }));
      // In one step the pick comes first: the leaving closes the last offer, and the step plays.
      const together = [OFFERED_TO_TWO, pick, leave, Scenario.refused(), left];
      // In two steps, the leave first: the pick closes the last offer, and its step plays.
      const apart = [
        OFFERED_TO_TWO,
        leave,
        left,
        pick,
        Scenario.step(STILL),
        Scenario.refused(),
      ];
      const [frozen, one, two] = [reading(), reading(), reading()];
      const [oneLater, twoLater] = [reading(), reading()];
      scenario(OFFERED_TO_TWO, frozen.now);
      scenario(together, one.now, Scenario.step(STILL, 120), oneLater.now);
      scenario(apart, two.now, Scenario.step(STILL, 120), twoLater.now);
      expect(one.read).toStrictEqual(two.read);
      // One step of play past the freeze, in both.
      expect(one.read.time).toBe(frozen.read.time + DT);
      // And they stay the same run.
      expect(oneLater.read).toStrictEqual(twoLater.read);
    }
  );

  it("refuse the pick of a hero that left in the step before", () => {
    scenario(
      OFFERED_TO_TWO,
      Scenario.step({ players: [], leaving: [1] }),
      Scenario.reported(new HeroLeft({ hero: 1 })),
      Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 }), 1),
      Scenario.step(STILL),
      Scenario.refused(new OfferClosed({ offer: 1 })),
      // The other hero's offer is still open: the run waits on it alone.
      Scenario.state((world) => {
        expect(offersOpen(world)).toStrictEqual([true, false]);
      })
    );
  });
});

describe("cue counters", () => {
  it("count shots, hits, kills, pickups, hurts, level-ups, downs and the loss", () => {
    const sturdy = Schema.decodeUnknownSync(GameContent)({
      ...content,
      heroes: content.heroes.map((hero) => ({ ...hero, maxHp: 1e9 })),
    });
    const world = createWorld(
      { content: sturdy, heroIds: ["bolter", "burner"] },
      { seed: 11 }
    );
    const { cues } = world;
    // One tough grunt on hero 1 from the start, so it gets hurt.
    addEnemy(world, world.heroes[1]!.x, world.heroes[1]!.z);
    step(world, STILL, STEP);
    expect([...cues.hurt]).toStrictEqual([0, 1]);
    for (let frame = 0; frame < 30 * 60; frame++) {
      for (const hero of world.heroes) {
        if (hero.offer) {
          choose(world, hero, 0);
        }
      }
      step(world, inputs({ moveX: 0, moveZ: 0 }), STEP);
    }
    expect({
      status: world.status,
      ranMostOfIt: world.time > 29,
      arcShots: cues.shots[0]! > 0,
      auraShots: cues.shots[1],
      hits: cues.hits > 0,
      kills: cues.kills,
      pickups: cues.pickups > 0,
      levelUps: cues.levelUps,
      hurtAgain: cues.hurt[1]! > 1,
    }).toStrictEqual({
      status: "running",
      ranMostOfIt: true,
      arcShots: true,
      auraShots: 0,
      hits: true,
      kills: world.kills,
      pickups: true,
      levelUps: world.level - 1,
      hurtAgain: true,
    });
    expect([...cues.downed, cues.won, cues.lost]).toStrictEqual([0, 0, 0, 0]);

    world.heroes[1]!.hp = 0;
    step(world, STILL, STEP);
    expect([...cues.downed, cues.lost]).toStrictEqual([0, 1, 0]);
    world.heroes[0]!.hp = 0;
    step(world, STILL, STEP);
    expect([...cues.downed, cues.won, cues.lost]).toStrictEqual([1, 1, 0, 1]);
  });

  it("counts a win", () => {
    const world = createWorld({ content, heroIds: ["burner"] }, { seed: 5 });
    world.time = content.rules.runLength - DT / 2;
    step(world, STILL, STEP);
    expect([world.cues.won, world.cues.lost]).toStrictEqual([1, 0]);
  });

  it("doesn't count aura damage as hits", () => {
    const world = createWorld({ content, heroIds: ["burner"] }, { seed: 5 });
    const i = addEnemy(world, 1.5, 0);
    for (let k = 0; k < 60; k++) {
      step(world, STILL, STEP);
    }
    expect(world.enemies.fields.hp[i]!).toBeLessThan(1000);
    expect([world.cues.hits, ...world.cues.shots]).toStrictEqual([0, 0, 0]);
  });

  it("leaves the counters out of the state hash", () => {
    const a = createWorld(
      { content, heroIds: ["bolter", "burner"] },
      { seed: 21 }
    );
    const b = createWorld(
      { content, heroIds: ["bolter", "burner"] },
      { seed: 21 }
    );
    play(a, 10);
    play(b, 10);
    b.cues.shots[0] = 999;
    b.cues.hurt[1] = 999;
    b.cues.hits += 5;
    b.cues.kills += 5;
    b.cues.pickups += 5;
    b.cues.levelUps += 5;
    expect(b.cues.hits).not.toBe(a.cues.hits);
    expect(hashWorld(b)).toBe(hashWorld(a));
  });
});
