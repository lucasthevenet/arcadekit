import { Coop } from "arcadekit/net/browser";

import { SurvivorsContent } from "../content";
import { RunEnded } from "../events";
import { hashWorld } from "../hash-world";
import { MAX_HEROES } from "../hero";
import { heroDevice } from "./device";
import { SurvivorsEngine } from "./game";

/**
 * Survivors for several players, each in their own browser, one hero per player by slot
 * (ADR-0013): the genre's engine, played in lockstep from a lobby. A lobby pick is a hero id, and
 * the picks, in player order, are the run's heroes. Each player's view follows its own hero, and
 * draws from the app's sheet as the single-player engine's does. `SurvivorsCoop.layer` provides
 * the Co-op client an app drives; a pick is the `ChooseUpgrade` command and the pause
 * `HoldPause`, sent through it, and the HUD says which heroes the run waits on to pick.
 */
export class SurvivorsCoop extends Coop("SurvivorsCoop", {
  engine: SurvivorsEngine,
  input: heroDevice,
  content: SurvivorsContent.load,
  picks: (content) => content.heroes.map((hero) => hero.id),
  config: (content, heroIds) => ({ content, heroIds }),
  maxPlayers: MAX_HEROES,
  hash: hashWorld,
  ends: [RunEnded],
}) {}
