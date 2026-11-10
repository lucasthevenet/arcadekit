import type { AudioSystem } from "arcadekit/audio";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { GameContent } from "../schema";
import { createWorld } from "../world";
import type { World } from "../world";
import { SurvivorsSoundView } from "./sound";
import type { SurvivorsSounds } from "./sound";

const weapon = {
  description: "",
  color: "#ffffff",
  damage: 10,
  damagePerLevel: 3,
  cooldown: 0.5,
  cooldownScalePerLevel: 0.9,
  maxLevel: 5,
};

const content = Schema.decodeUnknownSync(GameContent)({
  rules: {
    arenaHalfSize: 40,
    maxEnemies: 50,
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
      startingWeapon: "plain",
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
      ...weapon,
      id: "plain",
      name: "Plain",
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
      ...weapon,
      id: "loud",
      name: "Loud",
      sound: "shot-loud",
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
      ...weapon,
      id: "aura",
      name: "Aura",
      behavior: { kind: "aura", radius: 2.6, radiusPerLevel: 0.3 },
    },
  ],
  passives: [],
  waves: [{ from: 0, to: 120, enemy: "grunt", perSecond: 3 }],
});

const sounds: SurvivorsSounds = {
  shot: "shot",
  hit: "hit",
  kill: "kill",
  pickup: "pickup",
  hurt: "hurt",
  down: "down",
  levelUp: "level-up",
  won: "won",
  lost: "lost",
  auraHum: "hum",
};

/** An audio system that records what it is asked to play. */
const fakeAudio = () => {
  const plays: { id: string; volume: number | undefined }[] = [];
  const loops: { id: string; volume: number }[] = [];
  const audio: AudioSystem = {
    play: (id, options) => plays.push({ id, volume: options?.volume }),
    setLoop: (id, volume) => loops.push({ id, volume }),
    playMusic: () => {},
    setVolume: () => {},
    setMuted: () => {},
    setDucked: () => {},
    load: () => Effect.void,
  };
  return { audio, plays, loops };
};

const ids = (plays: readonly { id: string }[]) => plays.map(({ id }) => id);

const world = (heroIds: readonly string[] = ["bolter"]): World =>
  createWorld({ content, heroIds }, 1);

describe(SurvivorsSoundView, () => {
  it("only takes note of the counters on a run's first frame", () => {
    const { audio, plays } = fakeAudio();
    const view = new SurvivorsSoundView({ audio, sounds });
    const run = world();
    run.cues.kills = 5;
    run.cues.shots[0] = 3;

    view.render(run);

    expect(plays).toStrictEqual([]);
  });

  it("plays one sound per counter that rose, however far it rose", () => {
    const { audio, plays } = fakeAudio();
    const view = new SurvivorsSoundView({ audio, sounds });
    const run = world();
    view.render(run);

    run.cues.shots[0] = 4;
    run.cues.shots[1] = 1;
    run.cues.hits += 7;
    run.cues.kills += 2;
    run.cues.pickups += 1;
    run.cues.levelUps += 1;
    run.cues.won = 1;
    view.render(run);
    const firstFrame = ids(plays);
    plays.length = 0;
    view.render(run);

    expect({ firstFrame, secondFrame: ids(plays) }).toStrictEqual({
      firstFrame: [
        "shot",
        "shot-loud",
        "hit",
        "kill",
        "pickup",
        "level-up",
        "won",
      ],
      secondFrame: [],
    });
  });

  it("plays the local hero's hurt and down louder than a teammate's", () => {
    const { audio, plays } = fakeAudio();
    const view = new SurvivorsSoundView({ audio, sounds, localHero: () => 1 });
    const run = world(["bolter", "bolter"]);
    view.render(run);

    run.cues.hurt[0] = 1;
    run.cues.hurt[1] = 1;
    run.cues.downed[0] = 1;
    run.cues.lost = 1;
    view.render(run);

    expect(plays).toStrictEqual([
      { id: "hurt", volume: undefined },
      { id: "hurt", volume: 0.45 },
      { id: "down", volume: 0.45 },
      { id: "lost", volume: undefined },
    ]);
  });

  it("reads the local hero's slot on every render, so it follows a seat that changes", () => {
    const { audio, plays } = fakeAudio();
    let slot = 0;
    const view = new SurvivorsSoundView({
      audio,
      sounds,
      localHero: () => slot,
    });
    const run = world(["bolter", "bolter"]);
    view.render(run);

    run.cues.hurt[0] = 1;
    view.render(run);
    slot = 1;
    run.cues.hurt[0] = 2;
    view.render(run);

    expect(plays).toStrictEqual([
      { id: "hurt", volume: undefined },
      { id: "hurt", volume: 0.45 },
    ]);
  });

  it("starts over when the run changes", () => {
    const { audio, plays } = fakeAudio();
    const view = new SurvivorsSoundView({ audio, sounds });
    const first = world();
    view.render(first);
    first.cues.kills = 10;
    view.render(first);
    plays.length = 0;

    // A new run's counters are below the old run's: nothing plays, and they count from there.
    const second = world();
    view.render(second);
    const onNewRun = ids(plays);
    second.cues.kills = 1;
    view.render(second);

    expect({ onNewRun, after: ids(plays) }).toStrictEqual({
      onNewRun: [],
      after: ["kill"],
    });
  });

  it("starts over after a frame with no run", () => {
    const { audio, plays } = fakeAudio();
    const view = new SurvivorsSoundView({ audio, sounds });
    const run = world();
    view.render(run);
    view.render(null);
    run.cues.kills = 3;
    view.render(run);

    expect(plays).toStrictEqual([]);
  });

  it("hums while a playing hero has the aura, and stops otherwise", () => {
    const { audio, loops } = fakeAudio();
    const view = new SurvivorsSoundView({ audio, sounds, auraVolume: 0.5 });
    const bolter = world();
    const burner = world(["bolter", "burner"]);

    view.render(bolter);
    view.render(burner);
    burner.heroes[1]!.status = "down";
    view.render(burner);
    burner.heroes[1]!.status = "playing";
    view.render(burner);
    view.render(null);
    view.render(burner);
    view.dispose();

    expect(loops.map(({ volume }) => volume)).toStrictEqual([
      0, 0.5, 0, 0.5, 0, 0.5, 0,
    ]);
    expect(new Set(ids(loops))).toStrictEqual(new Set(["hum"]));
  });

  it("stops the hum while the run is frozen", () => {
    const { audio, loops } = fakeAudio();
    const view = new SurvivorsSoundView({ audio, sounds, auraVolume: 0.5 });
    const run = world(["burner"]);
    const hero = run.heroes[0]!;

    view.render(run, 0);
    // A held pause or an open upgrade offer, both in the state.
    hero.paused = true;
    view.render(run, 0.1);
    hero.paused = false;
    hero.offer = [];
    view.render(run, 0.2);
    hero.offer = null;
    run.time += 1 / 60;
    view.render(run, 0.3);
    // A single-player pause only stops the steps: frames between steps keep the hum, and it
    // stops once the run time stalls.
    view.render(run, 0.4);
    view.render(run, 0.6);
    run.time += 1 / 60;
    view.render(run, 0.7);

    expect(loops.map(({ volume }) => volume)).toStrictEqual([
      0.5, 0, 0, 0.5, 0.5, 0, 0.5,
    ]);
  });
});
