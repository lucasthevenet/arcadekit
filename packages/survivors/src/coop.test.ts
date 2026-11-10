import * as Game from "arcadekit/game";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ChooseUpgrade } from "./commands";
import { survivorsCoopRules as rules } from "./coop";
import { HeroLeft, Hud, LeveledUp, RunEnded } from "./events";
import type { SurvivorsEvent } from "./events";
import { hashWorld } from "./hash-world";
import { HeroInput } from "./input";
import { GameContent } from "./schema";
import { Survivors } from "./simulation";
import { hudSample } from "./world";

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

const still: HeroInput = { moveX: 0, moveZ: 0 };

/**
 * A two-player run of the rules' own simulation and config, on a loop as a lockstep session
 * steps it: its world, what it reported but its HUD samples, a step with every player's input,
 * and a player's pick, which the next step applies.
 */
const run = () => {
  const loop = new Game.Loop(rules.simulation);
  const reported: SurvivorsEvent[] = [];
  loop.subscribe((event) => {
    if (event._tag !== "Hud") {
      reported.push(event);
    }
  });
  loop.start(rules.config(content, ["burner", "bolter"]), 7, 0);
  return {
    world: loop.state!,
    reported,
    step: (
      players: readonly (HeroInput | null)[],
      leaving: readonly number[] = []
    ) => {
      loop.frame({ read: () => ({ players, leaving }) }, { steps: 1 }, 0);
    },
    pick: (slot: number) => {
      loop.send(
        new ChooseUpgrade({ offer: loop.state!.offerSeq, index: 0 }),
        slot
      );
    },
  };
};

/** A run whose team just leveled up: both heroes have offer 1 open. */
const offering = () => {
  const played = run();
  played.world.pendingLevelUps = 1;
  played.step([still, still]);
  return played;
};

describe("survivors' Co-op rules", () => {
  it("offers the content's hero ids as lobby picks, in order, and plays them by slot", () => {
    const { world } = run();
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

  it("runs the declared simulation, hashes with the world's hash, and sends a HeroInput unchanged", () => {
    const { world } = run();
    const input: HeroInput = { moveX: 0.5, moveZ: -1 };
    // What a lockstep session sends for one player: the one-player Schema of the step input.
    const player = Game.playerInputSchema(rules.simulation);
    const sent = Schema.encodeSync(player)(input);
    expect({
      simulation: rules.simulation === Survivors,
      player: player === HeroInput,
      hash: rules.hash(world),
      decoded: Schema.decodeUnknownResult(player)(sent),
    }).toStrictEqual({
      simulation: true,
      player: true,
      hash: hashWorld(world),
      decoded: Result.succeed(input),
    });
  });

  it("says a slot is choosing while its hero has an offer open, and no other", () => {
    const { world, step, pick } = offering();
    const open = [0, 1, 2].map((slot) => rules.choosing(world, slot));
    pick(0);
    step([still, still]);
    const afterOnePick = [0, 1, 2].map((slot) => rules.choosing(world, slot));
    // The other hero's offer closes without a pick when its player leaves.
    step([still, null], [1]);
    expect({
      before: [0, 1].map((slot) => rules.choosing(run().world, slot)),
      open,
      afterOnePick,
      afterLeaving: [0, 1].map((slot) => rules.choosing(world, slot)),
    }).toStrictEqual({
      before: [false, false],
      open: [true, true, false],
      afterOnePick: [false, true, false],
      afterLeaving: [false, false],
    });
  });

  it("tells the local player the HUD, its own hero's offer and its own summary", () => {
    const { world, reported, step } = offering();
    const offers = reported.filter((event) => event._tag === "LeveledUp");
    const hud = new Hud(hudSample(world));
    for (const hero of world.heroes) {
      hero.status = "down";
    }
    step([still, still]);
    const ended = reported.find((event) => event._tag === "RunEnded")!;
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

  it("keeps each run's events its own, though every run steps the one declared simulation", () => {
    // Lockstep peers in one process share the rules' simulation class, each with its own run.
    const [a, b] = [run(), run()];
    a.step([], [1]);
    b.step([still, still]);
    expect({ other: b.reported, own: a.reported }).toStrictEqual({
      other: [],
      own: [new HeroLeft({ hero: 1 })],
    });
  });

  it("says the run ended on RunEnded and on no other event", () => {
    const { world } = run();
    const events: SurvivorsEvent[] = [
      new Hud(hudSample(world)),
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
