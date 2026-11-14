/**
 * `@arcadekit/survivors`: the survivors-like genre's rules, with no DOM. Heroes, one per player,
 * hold out against waves of enemies with weapons that fire on their own, and pick an upgrade at
 * each level-up of the team.
 *
 * Its declarations are exported bare under their names: the events (`Hud`, `LeveledUp`,
 * `HeroLeft`, `RunEnded`), the commands with their rejections (`ChooseUpgrade`, `HoldPause`,
 * `OfferClosed`, `NoSuchChoice`, `NotPlaying`), the simulation (`Survivors`) and the content
 * (`SurvivorsContent`). Every other module is a namespace: a run's state, step and state hash
 * (`World`), a hero and one player's input (`Hero`), an upgrade offer (`Offer`), and the content's
 * Schema (`GameContent`). This is what co-op needs with no DOM: a lockstep peer steps `Survivors`
 * and compares `World.hash`. No DOM or Three.js here: `tsconfig.root.json` checks this entry with
 * no DOM types, and the engine and the Coop are in `@arcadekit/survivors/browser`.
 */
export {
  ChooseUpgrade,
  HoldPause,
  NoSuchChoice,
  NotPlaying,
  OfferClosed,
} from "./commands";
export { SurvivorsContent } from "./content";
export { HeroLeft, Hud, LeveledUp, RunEnded } from "./events";
export * as GameContent from "./game-content";
export * as Hero from "./hero";
export * as Offer from "./offer";
export { Survivors } from "./simulation";
export * as World from "./world";
