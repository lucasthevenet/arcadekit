import * as Game from "arcadekit/game";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as Controls from "../../../../src/survivors/browser/internal/controls";
import * as GameContent from "../../../../src/survivors/game-content";
import { Survivors } from "../../../../src/survivors/simulation";

// Runs survivors' real single-player input source: it reads keys through InputController, and a
// Game.Loop steps the simulation with it the way the demo's engine does. No view is created.
// No DOM either: Node's EventTarget stands in for the window and the surface, and
// navigator.getGamepads reports no pads.

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

let window: EventTarget;

const key = (type: "keydown" | "keyup", code: string) => {
  const event = new Event(type);
  Object.defineProperty(event, "code", { value: code });
  Object.defineProperty(event, "repeat", { value: false });
  window.dispatchEvent(event);
};

/** A started run of the simulation for one hero, and the real input source. */
const play = () => {
  const surface = Object.assign(new EventTarget(), {
    style: {},
    setPointerCapture: () => {},
  }) as unknown as HTMLElement;
  const input = Controls.makeSolo(surface);
  const loop = Game.makeLoop(Survivors);
  loop.start({ content, heroIds: ["bolter"] }, 1, 0);
  const hero = loop.state!.heroes[0]!;
  return {
    input,
    /** Runs `steps` steps in one frame. */
    run: (steps: number) => loop.frame(input, { steps }, 0),
    /** The hero's [x, z]. */
    at: () => [hero.x, hero.z],
  };
};

describe("survivors' input source, stepped by Game.Loop", () => {
  beforeEach(() => {
    window = new EventTarget();
    vi.stubGlobal("window", window);
    vi.stubGlobal("navigator", { getGamepads: () => [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("walks the first hero while a key is held, and stops it when the key is let go", () => {
    const { input, run, at } = play();
    const [startX, startZ] = at();
    key("keydown", "ArrowRight");
    run(30);
    const [heldX, heldZ] = at();
    key("keyup", "ArrowRight");
    run(30);
    input.dispose();
    expect({
      walkedRight: heldX! > startX!,
      keptItsRow: heldZ === startZ,
      stopped: at(),
    }).toStrictEqual({
      walkedRight: true,
      keptItsRow: true,
      stopped: [heldX, heldZ],
    });
  });

  it("fills one step input for the run, with nobody leaving", () => {
    const { input } = play();
    const first = input.read(0);
    const read = { players: [...first.players], leaving: [...first.leaving] };
    const same = input.read(1) === first;
    input.dispose();
    expect({ read, same }).toStrictEqual({
      read: { players: [{ moveX: 0, moveZ: 0 }], leaving: [] },
      same: true,
    });
  });
});
