import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { survivorsCoopRules as rules } from "./coop";
import { HeroLeft, LeveledUp, RunEnded } from "./events";
import type { SurvivorsEvent } from "./events";
import { hashWorld } from "./hash-world";
import type { HeroInput } from "./input";
import { GameContent } from "./schema";
import { survivorsSimulation } from "./simulation";
import type { World } from "./world";

// Survivors' Co-op rules, each as a plain function, in Node: what the Co-op client asks of the
// genre between steps. The client's own behaviour is tested in arcadekit/net/browser.

const content = Schema.decodeUnknownSync(GameContent)({
  rules: {
    arenaHalfSize: 30,
    maxEnemies: 50,
    xpToLevel2: 5,
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
  waves: [{ from: 0, to: 90, enemy: "grunt", perSecond: 1 }],
});

const DT = 1 / 60;
const still: HeroInput = { moveX: 0, moveZ: 0 };

/** A two-player run of the rules' own simulation and config. */
const run = (): World =>
  rules.simulation.create(rules.config(content, ["burner", "bolter"]), 7);

const step = (world: World, players: readonly (HeroInput | null)[]) => {
  rules.simulation.step(world, { players, leaving: [] }, DT);
};

/** A run whose team just leveled up: both heroes have offer 1 open. */
const offering = (): World => {
  const world = run();
  world.pendingLevelUps = 1;
  step(world, [still, still]);
  return world;
};

describe("survivors' Co-op rules", () => {
  it("offers the content's hero ids as lobby picks, in order, and plays them by slot", () => {
    const world = run();
    expect({
      picks: rules.picks(content),
      config: rules.config(content, ["burner", "bolter"]),
      heroes: world.heroes.map((hero) => hero.def.id),
      maxPlayers: rules.maxPlayers,
    }).toStrictEqual({
      picks: ["bolter", "burner"],
      config: { content, heroIds: ["burner", "bolter"] },
      heroes: ["burner", "bolter"],
      maxPlayers: 4,
    });
  });

  it("hashes with the world's hash and sends a HeroInput through the codec unchanged", () => {
    const world = run();
    const input: HeroInput = {
      moveX: 0.5,
      moveZ: -1,
      pick: { offer: 2, index: 1 },
      paused: true,
    };
    expect({
      hash: rules.hash(world),
      decoded: rules.codec.decode(rules.codec.encode(input)),
    }).toStrictEqual({
      hash: hashWorld(world),
      decoded: Result.succeed(input),
    });
  });

  it("says a slot is choosing while its hero has an offer open, and no other", () => {
    const world = offering();
    const open = [0, 1, 2].map((slot) => rules.choosing(world, slot));
    step(world, [{ ...still, pick: { offer: 1, index: 0 } }, still]);
    const afterOnePick = [0, 1, 2].map((slot) => rules.choosing(world, slot));
    expect({
      before: [0, 1].map((slot) => rules.choosing(run(), slot)),
      open,
      afterOnePick,
    }).toStrictEqual({
      before: [false, false],
      open: [true, true, false],
      afterOnePick: [false, true, false],
    });
  });

  it("holds a pick while its offer is open and settles it once applied", () => {
    const world = offering();
    const pick = { offer: 1, index: 0 };
    const held = rules.settled(pick, world, 0);
    step(world, [{ ...still, pick }, still]);
    expect({
      held,
      applied: rules.settled(pick, world, 0),
      // The other hero's offer is still open, so its own pick is still held.
      other: rules.settled(pick, world, 1),
    }).toStrictEqual({ held: false, applied: true, other: false });
  });

  it("settles a pick for another offer, and holds one for a slot with no hero", () => {
    const world = offering();
    expect({
      stale: rules.settled({ offer: 0, index: 0 }, world, 0),
      early: rules.settled({ offer: 2, index: 0 }, world, 0),
      // As the client always did: a slot with no hero has no offer to close.
      noHero: rules.settled({ offer: 1, index: 0 }, world, 5),
    }).toStrictEqual({ stale: true, early: true, noHero: false });
  });

  it("settles a pick whose hero's offer closed without it, when its player left", () => {
    const world = offering();
    const pick = { offer: 1, index: 0 };
    rules.simulation.step(world, { players: [still, null], leaving: [1] }, DT);
    expect([
      rules.settled(pick, world, 1),
      rules.choosing(world, 1),
    ]).toStrictEqual([true, false]);
  });

  it("fills one input object per run from the device, the held pick and the pause", () => {
    const fill = rules.localInput();
    const pick = { offer: 3, index: 2 };
    const first = fill({ moveX: 1, moveZ: -0.5 }, pick, true);
    const full = { ...first };
    const second = fill({ moveX: 0.25, moveZ: 0 }, null, false);
    const plain = { ...second };
    const third = fill(null, null, false);
    expect({
      full,
      plain,
      detached: { ...third },
      same: first === second && second === third,
      perRun: rules.localInput()(null, null, false) === first,
    }).toStrictEqual({
      full: { moveX: 1, moveZ: -0.5, pick, paused: true },
      // No `pick` or `paused` key once they are let go: the codec's optional keys.
      plain: { moveX: 0.25, moveZ: 0 },
      detached: { moveX: 0, moveZ: 0 },
      same: true,
      perRun: false,
    });
  });

  it("tells the local player the HUD, its own hero's offer and its own summary", () => {
    const world = offering();
    const offers = rules.simulation
      .drainEvents(world)
      .filter((event) => event._tag === "LeveledUp");
    const hud: SurvivorsEvent = survivorsSimulation.sample!.read(world);
    for (const hero of world.heroes) {
      hero.status = "down";
    }
    step(world, [still, still]);
    const ended = rules.simulation
      .drainEvents(world)
      .find((event) => event._tag === "RunEnded")!;
    const names = ["Host", "Guest 2"];
    expect({
      hud: rules.localEvent(hud, 1, names),
      offers: offers.map((event) => rules.localEvent(event, 1, names)),
      left: rules.localEvent(new HeroLeft({ hero: 0 }), 1, names),
      ended: rules.localEvent(ended, 1, names),
      noHero: rules.localEvent(ended, 2, names),
    }).toStrictEqual({
      hud: { type: "hud", hud },
      offers: [
        null,
        { type: "levelUp", offer: 1, choices: world.heroes[1]!.offer },
      ],
      left: null,
      ended: { type: "runEnded", summary: ended.summaries[1] },
      noHero: null,
    });
  });

  it("keeps each run's events its own, though every run steps through the one simulation", () => {
    // Lockstep peers in one process share the rules' simulation object, each with its own run.
    const [a, b] = [run(), run()];
    rules.simulation.step(a, { players: [], leaving: [1] }, DT);
    expect({
      other: rules.simulation.drainEvents(b),
      own: rules.simulation.drainEvents(a),
      drained: rules.simulation.drainEvents(a),
    }).toStrictEqual({
      other: [],
      own: [new HeroLeft({ hero: 1 })],
      drained: [],
    });
  });

  it("says the run ended on RunEnded and on no other event", () => {
    const world = run();
    const events: SurvivorsEvent[] = [
      survivorsSimulation.sample!.read(world),
      new LeveledUp({ hero: 0, offer: 1, choices: [] }),
      new HeroLeft({ hero: 1 }),
      new RunEnded({ summaries: [] }),
    ];
    expect(events.map((event) => rules.runEnded(event))).toStrictEqual([
      false,
      false,
      false,
      true,
    ]);
  });
});
