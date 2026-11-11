// A game's building blocks in the browser: everything the root entry has, plus `Game.Engine`,
// which runs a simulation on animation frames, draws it and reads its input. Import the entry as
// the same namespace, `Game`:
//
//   export class MyEngine extends Game.Engine("MyEngine", { simulation, view, input }) {}

import { make as makeEngine } from "./engine";
import type { Engine as RunningEngine } from "./engine";
import type { AnySimulation, CommandOf, ConfigOf, EventOf } from "./simulation";

export { AttachError } from "./attach-error";
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
export { GameCrashed, frameLoop } from "./frame-loop";
export { type FrameSource, animationFrames } from "./frames";
export type { FrameBudget } from "./kernel";
export { Command, Event, Rejection, Simulation } from "./index";
export { Loop } from "./loop";
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
export type { InputSource, StepInput } from "./step-input";
export { type GameView as View, combineViews } from "./view";
export {
  type EngineClass,
  type EngineDefinition,
  type EngineId,
  type EngineService,
  Frames,
  type LocalPlayer,
  type Used,
  type Uses,
  type ViewContext,
} from "./engine";

/** A game as the browser runs it for one player. See {@link makeEngine}. */
export const Engine: typeof makeEngine = makeEngine;
/**
 * A running game, as an app drives it: what `yield* MyEngine` gives. To name one, use
 * {@link EngineOf} with its simulation, which fills these in.
 */
export type Engine<Config, Event, Command, E, Refusals> = RunningEngine<
  Config,
  Event,
  Command,
  E,
  Refusals
>;

/**
 * The running engine of the simulation `S`: what `yield* MyEngine` gives, for a function that
 * takes one. `E` is what the engine's `uses` can fail with.
 *
 * ```ts
 * const restart = (engine: Game.EngineOf<typeof PushPuzzle>) => engine.start(config);
 * ```
 */
export type EngineOf<S extends AnySimulation, E = never> = RunningEngine<
  ConfigOf<S>,
  EventOf<S>,
  CommandOf<S>,
  E,
  S["~types"]["Refusals"]
>;
