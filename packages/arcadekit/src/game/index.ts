// A game's building blocks, DOM-free: what its rules are declared with, and the loop that steps
// them anywhere (a browser, a Web Worker, a server, a test). Import the entry as a namespace
// named `Game`, so a declaration reads `Game.Event(...)`:
//
//   export class LevelSolved extends Game.Event("LevelSolved", { moves: Schema.Int }) {}
//
// `Game.Engine`, which runs a simulation in the browser, is in the ./browser entry, and scenarios,
// which check one in a test, in the ./scenario entry.

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

/** A rare fact a run reports to the outside. See {@link makeEvent}. */
export const Event: typeof makeEvent = makeEvent;
/** A decision a player sends to a run. See {@link makeCommand}. */
export const Command: typeof makeCommand = makeCommand;
/** A reason the rules refuse a command. See {@link makeRejection}. */
export const Rejection: typeof makeRejection = makeRejection;
/** A game's rules, with no DOM. See {@link makeSimulation}. */
export const Simulation: typeof makeSimulation = makeSimulation;
