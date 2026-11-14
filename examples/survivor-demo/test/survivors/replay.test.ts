import * as Game from "arcadekit/game";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ChooseUpgrade } from "../../src/survivors/commands";
import * as GameContent from "../../src/survivors/game-content";
import type * as Hero from "../../src/survivors/hero";
import { Survivors } from "../../src/survivors/simulation";
import * as World from "../../src/survivors/world";

// Replay check: the same seed, the same input script and the same commands must give the same
// run, bit for bit. It steps the declared simulation, `Survivors`, with arcadekit/game's Loop, in
// the step order and sample timing of any declared host, so it guards the simulation, core's
// clock and the loop's step order. Its script has no endStep or endFrame; the kit's
// kernel.test.ts pins their order. It doesn't cover input devices or the view. A lockstep run
// steps this same `Survivors` through the same loop: lockstep.test.ts holds its peers to one
// another, and to a run played alone, step for step.

const content = Schema.decodeUnknownSync(GameContent.GameContent)({
  rules: {
    arenaHalfSize: 30,
    maxEnemies: 200,
    xpToLevel2: 3,
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

const LEG_MOVE_X = [1, 0.3, -1, 0.3];

/** Zig-zag movement: a leg every 90 steps. One object, refilled each step, as a device source does. */
const zigZag = (): Game.StepInput<Hero.Input> => {
  const input = { moveX: 0, moveZ: 0 };
  return {
    read: (step) => {
      const leg = Math.floor(step / 90) % 4;
      input.moveX = LEG_MOVE_X[leg]!;
      input.moveZ = leg % 2;
      return input;
    },
  };
};

/**
 * Plays a fixed input script, one step per frame at 60 frames a second: zig-zag movement, and
 * the second upgrade when offered, sent before the frame whose step applies it. Counts the
 * events and the HUD samples the run reported.
 */
const replay = (seed: number, steps: number) => {
  const loop = Game.makeLoop(Survivors);
  const script = Game.soloInput(zigZag());
  let events = 0;
  let samples = 0;
  loop.subscribe((event) => {
    if (event._tag === "Hud") {
      samples += 1;
    } else {
      events += 1;
    }
  });
  loop.start({ content, heroIds: ["bolter"] }, seed, 0);
  const world = loop.state!;
  for (let i = 0; i < steps && world.status === "running"; i++) {
    const nowMs = (i * 1000) / 60;
    const { offer } = world.heroes[0]!;
    if (offer) {
      loop.send(
        new ChooseUpgrade({
          offer: world.offerSeq,
          index: Math.min(1, offer.length - 1),
        })
      );
    }
    loop.frame(script, { steps: 1 }, nowMs);
  }
  return { world, events, samples };
};

describe("survivors replay", () => {
  it("gives an identical state hash for the same seed and input script", () => {
    const a = replay(1234, 60 * 60);
    const b = replay(1234, 60 * 60);
    // The script must exercise the run, or the hash proves little.
    expect(a.world.kills).toBeGreaterThan(20);
    expect(a.world.level).toBeGreaterThan(2);
    expect([World.hash(b.world), b.events, b.samples]).toStrictEqual([
      World.hash(a.world),
      a.events,
      a.samples,
    ]);
    // Recorded before any kit change for push-puzzle. If this changes, survivors plays differently.
    expect(World.hash(a.world)).toBe(1_294_328_663);
  });

  it("gives a different hash for a different seed", () => {
    expect(World.hash(replay(1234, 600).world)).not.toBe(
      World.hash(replay(4321, 600).world)
    );
  });
});
