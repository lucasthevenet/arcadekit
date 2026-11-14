import { AudioSystem } from "arcadekit/audio";
import type { CueSoundsOf } from "arcadekit/audio";
import * as Game from "arcadekit/game";
import { Frames } from "arcadekit/game/browser";
import { ManualFrames } from "arcadekit/game/testing";
import { FakeCoopRooms } from "arcadekit/net/testing";
import { SpriteSheet } from "arcadekit/render-three";
import { Context, Effect, Layer, Result, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SurvivorsCoop } from "../../../src/survivors/browser/coop";
import { SurvivorsCueTable } from "../../../src/survivors/browser/cue-table";
import { SurvivorsEngine } from "../../../src/survivors/browser/engine";
import * as Controls from "../../../src/survivors/browser/internal/controls";
import { SurvivorsSheet } from "../../../src/survivors/browser/sheet";
import { SurvivorsContent } from "../../../src/survivors/content";
import { RunEnded } from "../../../src/survivors/events";
import * as GameContent from "../../../src/survivors/game-content";
import * as Hero from "../../../src/survivors/hero";
import { Survivors } from "../../../src/survivors/simulation";
import * as World from "../../../src/survivors/world";

// Survivors' Coop declaration, in Node: what every peer of a run must agree on, read from the
// class as plain values and functions, and its input source on an EventTarget that stands in for
// the window and the surface, so its listeners can be counted. The Co-op client that runs the
// declaration is tested in arcadekit/net/browser; the rules a run steps in world.test.ts and
// lockstep.test.ts; the views' live local slot in arena-sprites.test.ts and sound-view.test.ts,
// and that the engine hands it to both in engine.test.ts.

const content = Schema.decodeUnknownSync(GameContent.GameContent)({
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
      color: "#ff8800",
      maxHp: 300,
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
  passives: [],
  waves: [{ from: 0, to: 90, enemy: "grunt", perSecond: 1 }],
});

/** The app's sounds, for a silent audio system: each cue plays a sound named after it. */
const sounds: CueSoundsOf<typeof SurvivorsCueTable> = {
  shot: "shot",
  hit: "hit",
  kill: "kill",
  pickup: "pickup",
  hurt: "hurt",
  down: "down",
  levelUp: "levelUp",
  won: "won",
  lost: "lost",
  auraHum: "auraHum",
};

/** An EventTarget that counts the listeners on it. */
const countingTarget = () => {
  const target = new EventTarget();
  let listening = 0;
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (...args: Parameters<typeof add>) => {
    listening += 1;
    add(...args);
  };
  target.removeEventListener = (...args: Parameters<typeof remove>) => {
    listening -= 1;
    remove(...args);
  };
  return { target, listening: () => listening };
};

let window: ReturnType<typeof countingTarget>;
let surface: ReturnType<typeof countingTarget>;
let element: HTMLElement;

const listening = () => [window.listening(), surface.listening()];

describe("survivors' Coop", () => {
  beforeEach(() => {
    window = countingTarget();
    surface = countingTarget();
    element = Object.assign(surface.target, {
      style: {},
    }) as unknown as HTMLElement;
    vi.stubGlobal("window", window.target);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the genre's engine for several players: the content's hero ids as lobby picks, played by slot", () => {
    const { picks, config, maxPlayers, hash, ends } = SurvivorsCoop.definition;
    const run = config(content, ["burner", "bolter"]);
    expect({
      engine: SurvivorsCoop.engine === SurvivorsEngine,
      simulation: SurvivorsCoop.engine.simulation === Survivors,
      picks: picks(content),
      config: run,
      heroes: World.make(run, { seed: 7 }).heroes.map((hero) => hero.def.id),
      maxPlayers,
      hash: hash === World.hash,
      ends,
    }).toStrictEqual({
      engine: true,
      simulation: true,
      picks: ["bolter", "burner"],
      config: { content, heroIds: ["burner", "bolter"] },
      heroes: ["burner", "bolter"],
      maxPlayers: 4,
      hash: true,
      ends: [RunEnded],
    });
  });

  it("sends one hero's input for each player, as the simulation's players' input declares it", () => {
    const input: Hero.Input = { moveX: 0.5, moveZ: -1 };
    // What a lockstep session sends for one player: the one-player Schema of the step input.
    const player = Game.playerInputSchema(Survivors);
    const sent = Schema.encodeSync(player)(input);
    expect({
      player: player === Hero.Input,
      source: SurvivorsCoop.definition.input === Controls.make,
      decoded: Schema.decodeUnknownResult(player)(sent),
    }).toStrictEqual({
      player: true,
      source: true,
      decoded: Result.succeed(input),
    });
  });

  it("reads the hero's movement from the surface into one object, and stops listening when disposed", () => {
    const input = Controls.make(element);
    const attached = listening();
    const first = input.read(0);
    const read = { ...first };
    const same = input.read(1) === first;
    input.dispose();
    expect({ attached, read, same, disposed: listening() }).toStrictEqual({
      attached: [3, 4],
      read: { moveX: 0, moveZ: 0 },
      same: true,
      disposed: [0, 0],
    });
  });

  it("fails to attach with the sheet's error, as the engine does, before any input is made", async () => {
    const error = new SpriteSheet.SpriteSheetError({
      file: "sprites/survivors.json",
      message: "no sheet",
    });
    const layer = SurvivorsCoop.layer.pipe(
      Layer.provide(FakeCoopRooms.layer(FakeCoopRooms.make())),
      Layer.provide(Layer.succeed(Frames, ManualFrames.make())),
      Layer.provide(AudioSystem.layerSilent),
      // The attach fails before a view is made, so nothing plays from the table.
      Layer.provide(SurvivorsCueTable.layer(sounds)),
      Layer.provide(SurvivorsSheet.layer(Effect.fail(error))),
      Layer.provide(
        Layer.succeed(SurvivorsContent, { load: Effect.succeed(content) })
      )
    );
    const failed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer);
          const coop = Context.get(context, SurvivorsCoop);
          return yield* Effect.flip(coop.attach(element));
        })
      )
    );
    expect([failed, listening()]).toStrictEqual([error, [0, 0]]);
  });
});
