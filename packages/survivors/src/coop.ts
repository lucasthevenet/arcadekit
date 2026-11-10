import type * as Game from "arcadekit/game";
import type { CoopRules, CoopTypes } from "arcadekit/net";

import type { ChooseUpgrade, HoldPause } from "./commands";
import type { Hud, RunSummary, SurvivorsEvent, UpgradeChoice } from "./events";
import { hashWorld } from "./hash-world";
import { MAX_HEROES } from "./hero";
import type { HeroInput } from "./input";
import type { GameContent } from "./schema";
import { Survivors } from "./simulation";
import type { SurvivorsConfig, World } from "./world";

// Survivors as a Co-op game's lockstep parts (ADR-0013): what `arcadekit/net/browser`'s Co-op
// client runs. DOM-free, so it is tested in Node. `./browser`'s `makeSurvivorsCoopGame` adds the
// content, the input and the views. What runs between steps here, `choosing`, is plain code.
//
// A lockstep run steps the declared `Survivors`, as the single-player engine does, and a
// player's decision reaches it the same way: a pick is the `ChooseUpgrade` command and the pause
// `HoldPause`, sent through the Co-op client (ADR-0020). What is still on the older contract is
// that these parts are a `CoopRules` object, not a declaration.

/**
 * What the local player's app hears of a co-op run: the team's HUD, the local hero's own
 * upgrade offer (pick from it with `ChooseUpgrade`, naming `offer`), and the local hero's
 * summary when the run ends.
 */
export type SurvivorsCoopEvent =
  | { readonly type: "hud"; readonly hud: Hud }
  | {
      readonly type: "levelUp";
      readonly offer: number;
      readonly choices: readonly UpgradeChoice[];
    }
  | { readonly type: "runEnded"; readonly summary: RunSummary };

/** Co-op survivors' types. A lobby pick is a hero id. */
export interface SurvivorsCoop extends CoopTypes {
  readonly Config: SurvivorsConfig;
  readonly State: World;
  readonly Event: SurvivorsEvent;
  readonly PlayerInput: HeroInput;
  readonly Command: Game.CommandOf<typeof Survivors>;
  readonly Refusals: Game.RefusalsOf<
    readonly [typeof ChooseUpgrade, typeof HoldPause]
  >;
  readonly LocalEvent: SurvivorsCoopEvent;
  readonly Content: GameContent;
}

/**
 * Survivors' lockstep parts: one hero per player, by slot.
 *
 * - `picks`: the content's hero ids. `config` plays them in player order.
 * - `choosing`: the slot's hero has an upgrade offer open.
 * - `localEvent`: the HUD, the local hero's own offer and its own summary.
 */
export const survivorsCoopRules: CoopRules<SurvivorsCoop> = {
  simulation: Survivors,
  hash: hashWorld,
  picks: (content) => content.heroes.map((hero) => hero.id),
  config: (content, heroIds) => ({ content, heroIds }),
  maxPlayers: MAX_HEROES,
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
