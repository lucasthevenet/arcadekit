/**
 * Survivors' Coop, declared: the genre for two to four players, each in their own browser, one
 * hero per player, played in lockstep from a lobby.
 *
 * The declaration names what a shared run needs beside the engine: one player's controls, the
 * content every peer loads, the lobby's picks (hero ids) and the config they make, the state hash
 * the peers compare, the most players, and the event that ends a run.
 */
import { Coop } from "arcadekit/net/browser";

import { SurvivorsContent } from "../content";
import { RunEnded } from "../events";
import * as Hero from "../hero";
import * as World from "../world";
import { SurvivorsEngine } from "./engine";
import * as Controls from "./internal/controls";

/**
 * Survivors for several players, each in their own browser, one hero per player by slot: the
 * genre's engine, played in lockstep from a lobby. A lobby pick is a hero id, and the picks, in
 * player order, are the run's heroes. Each player's view follows its own hero, and draws from the
 * app's sheet as the single-player engine's does.
 *
 * **When to use**
 *
 * In an app: provide the Co-op client with `SurvivorsCoop.layer` over the app's rooms, drive it
 * from Commands with `yield* SurvivorsCoop` (`host`, `join`, `choose`, `start`, `send`, `leave`),
 * and turn what it reports into Messages with `SurvivorsCoop.match`.
 *
 * **Details**
 *
 * A pick is the `ChooseUpgrade` command and the pause `HoldPause`, sent with the client's `send`:
 * each rides the player's next step to every peer. The HUD says which heroes the run waits on to
 * pick. Every peer loads `SurvivorsContent` and compares its hash; a guest whose content lacks a
 * hero the host started with refuses the start. The peers compare `World.hash` to catch a desync.
 * A run ends with `RunEnded`.
 *
 * **Example** (What every peer agrees on)
 *
 * ```ts
 * import { Hero } from "@arcadekit/survivors";
 * import { SurvivorsCoop, SurvivorsEngine } from "@arcadekit/survivors/browser";
 *
 * SurvivorsCoop.definition.engine === SurvivorsEngine; // => true
 * SurvivorsCoop.definition.maxPlayers === Hero.maxPerRun; // => true
 * ```
 *
 * @category declarations
 */
export class SurvivorsCoop extends Coop("SurvivorsCoop", {
  engine: SurvivorsEngine,
  input: Controls.make,
  content: SurvivorsContent.load,
  picks: (content) => content.heroes.map((hero) => hero.id),
  config: (content, heroIds) => ({ content, heroIds }),
  maxPlayers: Hero.maxPerRun,
  hash: World.hash,
  ends: [RunEnded],
}) {}
