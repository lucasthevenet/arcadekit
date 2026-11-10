// A game's building blocks in the browser: everything the root entry has, plus `Game.Engine`,
// which runs a simulation on animation frames, draws it and reads its input. Import the entry as
// the same namespace, `Game`:
//
//   export class MyEngine extends Game.Engine("MyEngine", { simulation, view, input }) {}

import { make as makeEngine } from "./engine";
import type { Engine as RunningEngine } from "./engine";

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
export { Loop } from "./loop";
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
  RefusalsOf,
  RejectionOf,
  RunContext,
  Sample,
  SimulationClass,
  SimulationTypes,
  StateOf,
  StepContext,
} from "./simulation";
export {
  type EngineClass,
  type EngineDefinition,
  type EngineId,
  type EngineService,
  Frames,
  type Used,
  type Uses,
} from "./engine";
export {
  AttachError,
  type FrameSource,
  GameCrashed,
  type GameView as View,
  animationFrames,
  combineViews,
  frameLoop,
} from "../runtime/browser";
export type { InputSource, StepInput } from "../runtime/index";

/** A game as the browser runs it for one player. See {@link makeEngine}. */
export const Engine: typeof makeEngine = makeEngine;
/** A running game, as an app drives it: what `yield* MyEngine` gives. */
export type Engine<
  Config,
  Event,
  Command,
  E = never,
  Refusals = unknown,
> = RunningEngine<Config, Event, Command, E, Refusals>;
