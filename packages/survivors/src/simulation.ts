import * as Game from "arcadekit/game";

import {
  ChooseUpgrade,
  HoldPause,
  NoSuchChoice,
  NotPlaying,
  OfferClosed,
} from "./commands";
import { HeroLeft, Hud, LeveledUp, RunEnded } from "./events";
import { SurvivorsInput } from "./input";
import { choose, createWorld, hudSample, hudVersion, step } from "./world";

/**
 * The survivors genre's rules: what `Game.Loop` steps in a browser, a Worker, on a server or in
 * a test, for one hero or for several. `./browser`'s `SurvivorsEngine` adds the input, the view
 * and the sound for one player.
 */
export class Survivors extends Game.Simulation("Survivors", {
  stepSeconds: 1 / 60,
  input: SurvivorsInput,
  events: [LeveledUp, HeroLeft, RunEnded],
  commands: [ChooseUpgrade, HoldPause],
  create: createWorld,
  step,
  apply: {
    ChooseUpgrade: (world, { offer, index }, { player }) => {
      // Decide first, then change: a refused pick leaves the world as it was.
      const hero = world.heroes[player];
      if (
        hero === undefined ||
        hero.offer === null ||
        offer !== world.offerSeq
      ) {
        return new OfferClosed({ offer });
      }
      if (hero.offer[index] === undefined) {
        return new NoSuchChoice({ offer, index });
      }
      choose(world, hero, index);
    },
    HoldPause: (world, { held }, { player }) => {
      // Decide first, then change: a refused pause leaves the world as it was. A run that is
      // over takes none, though the heroes of a run that was won are still "playing": it stays
      // as it ended.
      const hero = world.heroes[player];
      if (
        world.status !== "running" ||
        hero === undefined ||
        hero.status !== "playing"
      ) {
        return new NotPlaying();
      }
      hero.paused = held;
    },
  },
  // The HUD changes all the time, so it is read every 100 ms; its version moves when the run
  // ends, so the last read comes right after the frame that ended it.
  sample: {
    event: Hud,
    every: "100 millis",
    version: hudVersion,
    read: hudSample,
  },
}) {}
