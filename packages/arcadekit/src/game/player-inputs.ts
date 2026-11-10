import { Schema } from "effect";

import type { StepInput } from "../runtime/index";
import type { SimulationClass } from "./simulation";

// The step input of a simulation several players can play: every player's input for the step,
// plus the players leaving at it. Plain code, like the step that reads it (ADR-0017): whoever
// fills it keeps one object and refills it each step.

/**
 * The annotation `PlayerInputs` leaves on its Schema: the Schema of one player's input. An
 * annotation, not a property of the Schema, since `.annotate()` and `.check()` make a new Schema
 * that keeps the first one's annotations and nothing else of it.
 */
const PLAYER = "arcadekit/game/PlayerInputs";

declare const declared: unique symbol;

/**
 * One step's input for a simulation that several players can play: each player's input, by
 * slot, and the slots leaving at this step. A slot is a player's place in the run's player order
 * (host first in lockstep), fixed for the whole run. A simulation declares it as its `input`
 * with `Game.PlayerInputs(OnePlayersInput)`. `soloInput` fills it for one player, and a lockstep
 * session from the steps its host confirms.
 */
export interface PlayerInputs<PlayerInput> {
  /** Each player's input, by slot. Null for a player with no input this step. */
  readonly players: readonly (PlayerInput | null)[];
  /** The slots of the players who leave the run at this step, in ascending order. */
  readonly leaving: readonly number[];
  /**
   * Types only: never set, never read. It tells the step input `Game.PlayerInputs` declares
   * from a struct with the same two fields written by hand, which has no one-player Schema for
   * a host to read. A value needs none: `{ players: [input], leaving: [] }` is a players' input.
   */
  readonly [declared]?: PlayerInput;
}

/** The Schema `Game.PlayerInputs` returns: the players' step input, from one player's `P`. */
export type PlayerInputsSchema<P extends Schema.Top> = Schema.Codec<
  PlayerInputs<P["Type"]>,
  PlayerInputs<P["Encoded"]>,
  P["DecodingServices"],
  P["EncodingServices"]
>;

/**
 * One player's input in the players' step input `Input`: what one player's devices hold for a
 * step, and what a lockstep session sends for that player. Never, for a step input that was not
 * declared with `Game.PlayerInputs`.
 */
export type PlayerInputOf<Input> = typeof declared extends keyof Input
  ? Input extends PlayerInputs<infer PlayerInput>
    ? PlayerInput
    : never
  : never;

/**
 * `Input`, where it was declared with `Game.PlayerInputs`. For any other step input, a type no
 * value has, whose text is what the type error then says to write. It tells the two apart only
 * for an `Input` that is the simulation's own, inferred from it: see `PlayersSimulation`.
 */
type DeclaredPlayerInputs<Input> = typeof declared extends keyof Input
  ? Input
  : "declare the simulation's `input` with Game.PlayerInputs(OnePlayersInput)";

/**
 * A simulation several players can play, as a host that seats them asks for it: a
 * `Game.Simulation` class whose step input, `Input`, was declared with `Game.PlayerInputs`. A
 * lockstep session takes one, and reads the Schema of one player's input from it with
 * `playerInputSchema`.
 *
 * A simulation with any other step input, a struct written by hand with `players` and `leaving`
 * included, is a type error that names `Game.PlayerInputs` where a host infers `Input` from the
 * simulation it is handed: `hostLockstep`, `playerInputSchema`. Where `Input` is named, as in
 * `CoopRules` (`PlayersSimulation<Config, State, PlayerInputs<P>, ...>`), the types can't tell:
 * such a struct's type is a players' input's too, since the mark is optional, and the host's
 * throw is the only refusal. So a builder that is to refuse one by type takes the simulation as
 * a type parameter, or its `Input`, and doesn't name the step input itself.
 */
export type PlayersSimulation<Config, State, Input, Event, Command, Refusals> =
  SimulationClass<string, Config, State, Input, Event, Command, Refusals> & {
    readonly "~types": { readonly Input: DeclaredPlayerInputs<Input> };
  };

/**
 * The step input of a simulation that several players can play, as a Schema, from the Schema of
 * one player's input: `players` holds each player's input by slot, or null for a player with no
 * input this step, and `leaving` the slots of the players removed at this step. A simulation
 * declares it as its `input`, and every host then knows how to seat players: `soloInput` puts
 * one player's devices at slot 0, and a lockstep session sends each player's own input and
 * combines them by slot.
 *
 * ```ts
 * export const HeroInput = Schema.Struct({ moveX: Schema.Number, moveZ: Schema.Number });
 * export const SurvivorsInput = Game.PlayerInputs(HeroInput);
 * export type SurvivorsInput = typeof SurvivorsInput.Type;
 *
 * export class Survivors extends Game.Simulation("Survivors", {
 *   input: SurvivorsInput,
 *   create: createWorld,
 *   step,
 * }) {}
 * ```
 *
 * It is a Schema: `.annotate()` and `.check()` give a players' input too. A struct with the same
 * two fields written by hand is not one. A host that seats several players refuses a simulation
 * declared with it: by throwing, and before that as a type error where the host infers the step
 * input from the simulation it is handed (`PlayersSimulation` says where the types can't tell).
 */
export const PlayerInputs = <P extends Schema.Top>(
  player: P
): PlayerInputsSchema<P> =>
  Schema.Struct({
    players: Schema.Array(Schema.NullOr(player)),
    leaving: Schema.Array(Schema.Int),
  }).annotate({ [PLAYER]: player });

/**
 * The Schema of one player's input for one step of `simulation`: what a host that seats several
 * players sends for each of them. A lockstep session reads it when it is made.
 *
 * ```ts
 * const HeroInput = Game.playerInputSchema(Survivors);
 * ```
 *
 * Throws for a simulation whose `input` was not declared with `Game.PlayerInputs`: what a cast,
 * plain JavaScript or a type that names the step input, as `CoopRules` does, gets past
 * `PlayersSimulation`'s type error.
 */
export const playerInputSchema = <Input>(
  simulation: PlayersSimulation<
    unknown,
    unknown,
    Input,
    unknown,
    unknown,
    unknown
  >
): Schema.Codec<PlayerInputOf<Input>, unknown> => {
  // Read from the Schema's own annotations: a check's annotations are its own.
  const player = simulation.definition.input.ast.annotations?.[PLAYER];
  if (!Schema.isSchema(player)) {
    throw new Error(
      `Simulation "${simulation.simulationName}" can't seat several players: its \`input\` was not declared with Game.PlayerInputs. Declare \`input: Game.PlayerInputs(OnePlayersInput)\`, from the Schema of one player's input for one step. A struct with \`players\` and \`leaving\` written by hand is not one: a host reads one player's Schema from what Game.PlayerInputs returns.`
    );
  }
  return player as Schema.Codec<PlayerInputOf<Input>, unknown>;
};

/**
 * A single player's step input from one player's source: slot 0's input, nobody leaving. What an
 * engine's `input` returns for a simulation several players can play, and what a replay or a
 * test steps one with. Returns one object, refilled each step. `endStep` and `endFrame` reach
 * `source`.
 *
 * ```ts
 * loop.frame(Game.soloInput({ read: () => ({ moveX: 1, moveZ: 0 }) }), { steps: 60 }, 0);
 * ```
 */
export const soloInput = <PlayerInput>(
  source: StepInput<PlayerInput>
): StepInput<PlayerInputs<PlayerInput>> => {
  const players: (PlayerInput | null)[] = [null];
  const input: PlayerInputs<PlayerInput> = { players, leaving: [] };
  return {
    read: (step) => {
      players[0] = source.read(step);
      return input;
    },
    endStep: () => source.endStep?.(),
    endFrame: () => source.endFrame?.(),
  };
};
