import type { CoopRules, CoopTypes } from "arcadekit/net";

import type { Hud, RunSummary, SurvivorsEvent, UpgradeChoice } from "./events";
import { hashWorld } from "./hash-world";
import { MAX_HEROES } from "./hero";
import type { HeroInput, UpgradePick } from "./input";
import type { GameContent } from "./schema";
import { Survivors } from "./simulation";
import type { SurvivorsConfig, World } from "./world";

// Survivors as a Co-op game's lockstep parts (ADR-0013): what `arcadekit/net/browser`'s Co-op
// client runs. DOM-free, so it is tested in Node. `./browser`'s `makeSurvivorsCoopGame` adds the
// content, the input and the views. Everything here that runs between steps is plain code.
//
// A lockstep run steps the declared `Survivors`, as the single-player engine does. What is still
// on the older contract is how a player's decision reaches it (ADR-0020): a pick and a pause
// ride the step input, held there by the Co-op client, where one player sends a command.

/**
 * What the local player's app hears of a co-op run: the team's HUD, the local hero's own
 * upgrade offer (answer it with an `UpgradePick` naming `offer`), and the local hero's summary
 * when the run ends.
 */
export type SurvivorsCoopEvent =
  | { readonly type: "hud"; readonly hud: Hud }
  | {
      readonly type: "levelUp";
      readonly offer: number;
      readonly choices: readonly UpgradeChoice[];
    }
  | { readonly type: "runEnded"; readonly summary: RunSummary };

/** Co-op survivors' types. A lobby pick is a hero id; an answer is an upgrade pick. */
export interface SurvivorsCoop extends CoopTypes {
  readonly Config: SurvivorsConfig;
  readonly State: World;
  readonly Event: SurvivorsEvent;
  readonly PlayerInput: HeroInput;
  readonly Answer: UpgradePick;
  readonly LocalEvent: SurvivorsCoopEvent;
  readonly Content: GameContent;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Survivors' lockstep parts: one hero per player, by slot.
 *
 * - `picks`: the content's hero ids. `config` plays them in player order.
 * - `choosing`: the slot's hero has an upgrade offer open.
 * - `settled`: the pick's offer closed, because it was applied or the level-up ended without it.
 * - `localInput`: the device's movement, the held pick and the held pause, as one `HeroInput`.
 * - `localEvent`: the HUD, the local hero's own offer and its own summary.
 */
export const survivorsCoopRules: CoopRules<SurvivorsCoop> = {
  simulation: Survivors,
  hash: hashWorld,
  picks: (content) => content.heroes.map((hero) => hero.id),
  config: (content, heroIds) => ({ content, heroIds }),
  maxPlayers: MAX_HEROES,
  localInput: () => {
    // One object for the run, refilled each step.
    const input: Mutable<HeroInput> = { moveX: 0, moveZ: 0 };
    return (device, pick, paused) => {
      input.moveX = device === null ? 0 : device.moveX;
      input.moveZ = device === null ? 0 : device.moveZ;
      if (pick === null) {
        delete input.pick;
      } else {
        input.pick = pick;
      }
      if (paused) {
        input.paused = true;
      } else {
        delete input.paused;
      }
      return input;
    };
  },
  settled: (pick, world, slot) =>
    world.offerSeq !== pick.offer || world.heroes[slot]?.offer === null,
  choosing: (world, slot) => {
    const hero = world.heroes[slot];
    return hero !== undefined && hero.offer !== null;
  },
  localEvent: (event, slot) => {
    switch (event._tag) {
      case "Hud": {
        return { type: "hud", hud: event };
      }
      case "LeveledUp": {
        return event.hero === slot
          ? { type: "levelUp", offer: event.offer, choices: event.choices }
          : null;
      }
      case "RunEnded": {
        const summary = event.summaries[slot];
        return summary === undefined ? null : { type: "runEnded", summary };
      }
      case "HeroLeft": {
        return null;
      }
    }
  },
  runEnded: (event) => event._tag === "RunEnded",
};
