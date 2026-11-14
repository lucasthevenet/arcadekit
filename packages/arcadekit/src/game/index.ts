/**
 * `arcadekit/game`: a game's building blocks, DOM-free. What a game's rules are declared with, and
 * the loop that steps them anywhere: a browser, a Web Worker, a server, a test.
 *
 * The entry is one module, which a game imports whole as `Game`: its declarations are its
 * callable members (`class LevelSolved extends Game.Event(...) {}`), beside the loop and the
 * types a game reads. This file assembles the module from its files, each written as an Effect
 * module is. `arcadekit/game/browser` is this module and the engine; scenarios, which check a
 * simulation in a test, are `arcadekit/game/scenario`; and the frames a test drives an engine on
 * are `arcadekit/game/testing`.
 *
 * Plain on purpose, where a step runs: a simulation's handlers and the loop that runs
 * them give the same bits on every peer and finish in the call.
 *
 * @since 0.7.0
 */
import { make as makeCommand } from "./command";
import { make as makeEvent } from "./event";
import { make as makeRejection } from "./rejection";
import { make as makeSimulation } from "./simulation";

export {
  type AnyCommand,
  type CommandClass,
  CommandDropped,
  type CommandInstance,
  type Settled,
} from "./command";
export type {
  AnyEvent,
  EventClass,
  EventInstance,
  Fields,
  NoFields,
  Payload,
} from "./event";
export { type Loop, isLoop, makeLoop } from "./loop";
export {
  type PlayerInputOf,
  PlayerInputs,
  type PlayerInputsSchema,
  type PlayersSimulation,
  playerInputSchema,
  soloInput,
} from "./player-inputs";
export type {
  AnyRejection,
  RejectionClass,
  RejectionInstance,
} from "./rejection";
export type {
  AnySimulation,
  CommandContext,
  CommandHandlers,
  CommandOf,
  ConfigOf,
  Definition,
  EventCases,
  EventOf,
  InputOf,
  NoHandlers,
  Nothing,
  RefusalFor,
  RefusalOf,
  RefusalsOf,
  RejectionOf,
  RunContext,
  Sample,
  SimulationClass,
  SimulationTypes,
  StateOf,
  StepContext,
} from "./simulation";
export type { FrameBudget, InputSource, StepInput } from "./step-input";

/**
 * Declares an event: a rare fact a run reports to the outside, named in the past tense. The
 * class is the event's constructor and its Schema.
 *
 * **When to use**
 *
 * For each thing the UI, the sound or an analytics hook should hear of, and for a sample: the
 * loop's read of the state for a HUD.
 *
 * **Example** (An event and its value)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class LevelSolved extends Game.Event("LevelSolved", { moves: Schema.Int }) {}
 * new LevelSolved({ moves: 3 }).moves; // => 3
 * ```
 *
 * @category declarations
 * @since 0.7.0
 */
export const Event: typeof makeEvent = makeEvent;

/**
 * Declares a command: a decision a player sends to a run, named in the imperative. The loop
 * applies it at the start of the next step, through the simulation's `apply` handler of its tag.
 *
 * **When to use**
 *
 * For a decision a screen makes, such as an upgrade picked from a menu. What a device holds for
 * a step is the simulation's `input`.
 *
 * **Example** (A command that may be refused)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class OfferClosed extends Game.Rejection("OfferClosed") {}
 * class ChooseUpgrade extends Game.Command("ChooseUpgrade", { index: Schema.Int }, {
 *   rejects: [OfferClosed],
 * }) {}
 * ChooseUpgrade.rejects[0]?.tag; // => "OfferClosed"
 * ```
 *
 * @category declarations
 * @since 0.7.0
 */
export const Command: typeof makeCommand = makeCommand;

/**
 * Declares a rejection: a reason the rules refuse a command, named for what is wrong. Its values
 * are errors, so the sender of the refused command handles one by its tag.
 *
 * **When to use**
 *
 * For each way the rules may turn down a command, listed in that command's `rejects`.
 *
 * **Example** (A rejection is an error)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class OfferClosed extends Game.Rejection("OfferClosed", { offer: Schema.Int }) {}
 * new OfferClosed({ offer: 1 }) instanceof Error; // => true
 * ```
 *
 * @category declarations
 * @since 0.7.0
 */
export const Rejection: typeof makeRejection = makeRejection;

/**
 * Declares a simulation: a game's rules, with no DOM. A loop steps it, `Game.Engine` runs it in
 * the browser, and a scenario checks it.
 *
 * **When to use**
 *
 * Once per game, for its rules.
 *
 * **Example** (Rules that count their steps)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: (count) => {
 *     count.steps += 1;
 *   },
 * }) {}
 * const loop = Game.makeLoop(Count);
 * loop.start(null, 0, 0);
 * loop.frame({ read: () => null }, { steps: 3 }, 0); // => 3
 * ```
 *
 * @category declarations
 * @since 0.7.0
 */
export const Simulation: typeof makeSimulation = makeSimulation;
