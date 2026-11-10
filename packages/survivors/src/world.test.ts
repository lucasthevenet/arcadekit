import * as Game from "arcadekit/game";
import * as Scenario from "arcadekit/game/scenario";
import { GameLoop, soloInput } from "arcadekit/runtime";
import type { StepInput } from "arcadekit/runtime";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ChooseUpgrade, NoSuchChoice, OfferClosed } from "./commands";
import { HeroLeft, Hud, LeveledUp, RunEnded } from "./events";
import type { SurvivorsEvent } from "./events";
import { hashWorld } from "./hash-world";
import type { HeroInput, SurvivorsInput } from "./input";
import { GameContent } from "./schema";
import { Survivors, survivorsSimulation } from "./simulation";
import { chooseUpgrade, createWorld, hudSample, step } from "./world";
import type { SurvivorsConfig, World } from "./world";

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
    if (world.heroes[0]!.offer) {
      chooseUpgrade(world, 0, 0);
    }
    const angle = frame / 200;
    step(world, solo(Math.cos(angle), Math.sin(angle)), context);
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

/** What `Game.Loop` and the older `GameLoop` both have, so one script plays on either. */
interface PlayingLoop {
  readonly state: World | null;
  readonly start: (
    config: SurvivorsConfig,
    seed: number,
    nowMs: number
  ) => void;
  readonly subscribe: (listener: (event: SurvivorsEvent) => void) => () => void;
  readonly frame: (
    input: StepInput<SurvivorsInput>,
    budget: { readonly steps: number },
    nowMs: number
  ) => number;
}

/**
 * Plays a minute of one sturdy hero's run on `loop`, a step a frame: it walks a slow circle and
 * takes the second upgrade of every offer. `pick` makes that pick before the frame whose step
 * applies it; without one the pick rides the step input, as a lockstep player's does. Returns
 * the state's hash after every step, and what the run reported, in order.
 */
const pickingRun = (
  loop: PlayingLoop,
  pick?: (world: World, index: number, nowMs: number) => void
) => {
  const sturdy = Schema.decodeUnknownSync(GameContent)({
    ...content,
    heroes: [{ ...content.heroes[0], maxHp: 1e9 }],
  });
  const hashes: number[] = [];
  const events: SurvivorsEvent[] = [];
  loop.subscribe((event) => {
    events.push(event);
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
      if (pick === undefined && offer) {
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
    if (pick !== undefined && offer) {
      pick(world, Math.min(1, offer.length - 1), nowMs);
    }
    loop.frame(input, { steps: 1 }, nowMs);
    hashes.push(hashWorld(world));
  }
  return { hashes, events, level: world.level };
};

/** The picking run on the declared loop, each pick a `ChooseUpgrade`. */
const commandedRun = () => {
  const loop = new Game.Loop(Survivors);
  return pickingRun(loop, (world, index) => {
    loop.send(new ChooseUpgrade({ offer: world.offerSeq, index }));
  });
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
    expect(chooseUpgrade(world, 0, 0)).toBe(true);
    expect(world.heroes[0]!.offer).toBeNull();
  });

  it("reports RunEnded once when the player dies", () => {
    const world = createWorld({ content, heroIds: ["bolter"] }, { seed: 1 });
    world.heroes[0]!.hp = 0.0001;
    const { events, context } = collecting();
    for (let i = 0; i < 60 * 60 && world.status === "running"; i++) {
      if (world.heroes[0]!.offer) {
        chooseUpgrade(world, 0, 0);
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

  it("plays the same run whether a pick is a command or rides the step input", () => {
    // One player picks with `ChooseUpgrade`; a lockstep player's pick still rides its input.
    // Either way it is applied before the rules of the same step, so the run is the same.
    const commanded = commandedRun();
    const riding = pickingRun(new Game.Loop(Survivors));
    expect(commanded.level).toBeGreaterThan(3);
    expect(riding.hashes).toStrictEqual(commanded.hashes);
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

// `survivorsSimulation` is what the hosts still on the older contract step: `./browser`'s
// single-player engine, which picks through `modify`, and the lockstep run of the Co-op rules.
// Every recorded hash is of `Survivors`, so these hold the one to the other. They go with it,
// when those hosts have moved (ADR-0020).
describe("the older simulation", () => {
  it("plays the declared simulation's run, step for step, picking through modify", () => {
    const commanded = commandedRun();
    const loop = new GameLoop(survivorsSimulation);
    const modified = pickingRun(loop, (_, index, nowMs) => {
      loop.modify((world) => chooseUpgrade(world, 0, index), nowMs);
    });
    expect(modified.hashes).toStrictEqual(commanded.hashes);
    expect(modified.events).toStrictEqual(commanded.events);
  });

  it("reports RunEnded and then the last HUD in the frame that ends a run", () => {
    const loop = new GameLoop(survivorsSimulation);
    let heard: SurvivorsEvent[] = [];
    loop.subscribe((event) => {
      heard.push(event);
    });
    loop.start({ content: brief, heroIds: ["burner"] }, 1, 0);
    const world = loop.state!;
    // Four frames in 30 ms: the HUD's 100 ms have not passed, so only the run's end has it read.
    for (let frame = 0; frame < 4; frame++) {
      heard = [];
      loop.frame({ read: () => STILL }, { steps: 1 }, frame * 10);
    }
    const time = clockAfter(4);
    expect([world.status, world.time]).toStrictEqual(["won", time]);
    expect(heard).toStrictEqual([
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
      }),
      // Nothing changes a run that is over, so this is the HUD as its last step left it.
      new Hud(hudSample(world)),
    ]);
  });
});

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

    step(
      world,
      inputs({ moveX: 1, moveZ: 0, pick: { offer: 1, index: 0 } }),
      STEP
    );
    expect([
      offersOpen(world),
      world.time,
      world.pendingLevelUps,
    ]).toStrictEqual([[false, true], time, 1]);

    step(
      world,
      inputs(null, { moveX: 0, moveZ: 0, pick: { offer: 1, index: 0 } }),
      STEP
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
      STEP
    );
    step(
      world,
      inputs({ moveX: 0, moveZ: 0, pick: { offer: 1, index: 9 } }),
      STEP
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
      STEP
    );
    expect(a.weapons.map((slot) => slot.level)).toStrictEqual(weapons);
    expect([...a.passiveLevels]).toStrictEqual(passives);
  });

  it("lets a leaving player's open offer go, and no longer chases its hero", () => {
    const world = levelUpForTwo();
    chooseUpgrade(world, 0, 0);
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
    chooseUpgrade(world, 0, 0);
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

  it("holds a co-op run paused while a playing hero's player pauses", () => {
    const world = createWorld(
      { content, heroIds: ["bolter", "burner"] },
      { seed: 3 }
    );
    step(world, STILL, STEP);
    const { time } = world;
    step(world, inputs(null, { moveX: 0, moveZ: 0, paused: true }), STEP);
    expect(world.time).toBe(time);
    expect(hudSample(world).heroes.map((hero) => hero.paused)).toStrictEqual([
      false,
      true,
    ]);
    step(world, STILL, STEP);
    expect(world.time).toBe(time + DT);
    // A downed hero's player can't hold the run.
    world.heroes[1]!.hp = 0;
    step(world, STILL, STEP);
    step(world, inputs(null, { moveX: 0, moveZ: 0, paused: true }), STEP);
    expect(world.time).toBe(time + 3 * DT);
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
          chooseUpgrade(world, hero.slot, 0);
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
