import * as Game from "arcadekit/game";

import { ChooseUpgrade, NoSuchChoice, OfferClosed } from "./commands";
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
  commands: [ChooseUpgrade],
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
