/**
 * `arcadekit/game/browser`: a game's building blocks in the browser. It is the whole of
 * `arcadekit/game`, and `Game.Engine`, which runs a simulation on animation frames, draws it and
 * reads its input, with what an engine draws on: its frames, its views and its frame loop.
 *
 * The entry is one module, which a file imports whole as `Game`, as it imports the root entry:
 * one file imports one of the two. This file assembles the module from the files of both, each
 * written as an Effect module is, and names every member the root entry has.
 *
 * @since 0.7.0
 */
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
export { Command, Event, Rejection, Simulation } from "./index";
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
export {
  type EngineClass,
  type EngineDefinition,
  type EngineId,
  type EngineService,
  isEngine,
  type LocalPlayer,
  type Used,
  type Uses,
  type ViewContext,
} from "./engine";
export { GameCrashed, frameLoop } from "./frame-loop";
export { type FrameSource, Frames, animationFrames } from "./frames";
export { type View, combineViews } from "./view";

/**
 * Declares an engine: a game as the browser runs it for one player, its simulation and the view
 * and input source that draw a run and read its input. The class is the key of the running
 * engine, and its `layer` provides it.
 *
 * **When to use**
 *
 * Once per game that runs in the browser.
 *
 * **Example** (An engine and its key)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: () => {},
 * }) {}
 * class CountEngine extends Game.Engine("CountEngine", {
 *   simulation: Count,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * }) {}
 * CountEngine.key; // => "arcadekit/game/Engine/CountEngine"
 * ```
 *
 * @category declarations
 * @since 0.7.0
 */
export const Engine: typeof makeEngine = makeEngine;

/**
 * A running game, as an app drives it: what `yield* MyEngine` gives.
 *
 * **When to use**
 *
 * Rarely: `Game.EngineOf<typeof MySimulation>` names one from its simulation, which fills these
 * in.
 *
 * **Example** (Naming the running engine)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: () => {},
 * }) {}
 * class CountEngine extends Game.Engine("CountEngine", {
 *   simulation: Count,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * }) {}
 *
 * const restart = (engine: Game.Engine<null, never, never, never, {}>) => engine.start(null);
 * const program = Effect.gen(function* () {
 *   yield* restart(yield* CountEngine);
 *   return "restarted";
 * });
 * Effect.runSync(program.pipe(Effect.provide(CountEngine.layer))); // => "restarted"
 * ```
 *
 * @category models
 * @since 0.7.0
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
 * **When to use**
 *
 * To type a function of an app's that takes the engine, such as one that restarts a run.
 *
 * **Example** (A function that takes the engine)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: (config: { readonly from: number }) => ({ steps: config.from }),
 *   step: () => {},
 * }) {}
 * class CountEngine extends Game.Engine("CountEngine", {
 *   simulation: Count,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * }) {}
 *
 * const restart = (engine: Game.EngineOf<typeof Count>) => engine.start({ from: 0 }, { seed: 1 });
 * const program = Effect.gen(function* () {
 *   yield* restart(yield* CountEngine);
 *   return "restarted";
 * });
 * Effect.runSync(program.pipe(Effect.provide(CountEngine.layer))); // => "restarted"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type EngineOf<S extends AnySimulation, E = never> = RunningEngine<
  ConfigOf<S>,
  EventOf<S>,
  CommandOf<S>,
  E,
  S["~types"]["Refusals"]
>;
