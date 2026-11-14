/**
 * Player inputs: the step input of a simulation several players can play, every player's input
 * for the step by slot, and the slots leaving at it.
 *
 * A simulation declares it as its `input` with `Game.PlayerInputs(OnePlayersInput)`, and every
 * host then seats players the same way: `soloInput` puts one player's source at slot 0, and a
 * lockstep session sends each player's own input and puts each at its slot. Plain code, like the
 * step that reads it: every peer steps on it, and whoever fills it keeps one object
 * and refills it each step.
 *
 * @since 0.7.0
 */
import { Schema } from "effect";

import type { SimulationClass } from "./simulation";
import type { StepInput } from "./step-input";

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
 * (host first in lockstep), fixed for the whole run.
 *
 * **When to use**
 *
 * To type what a simulation's `step` reads, or a players' input a test or a replay fills by hand.
 * A simulation declares it as its `input` with `Game.PlayerInputs(OnePlayersInput)`.
 *
 * **Details**
 *
 * It is a type a game writes as a literal: `{ players: [input], leaving: [] }` is one. `soloInput`
 * fills it for one player, and a lockstep session from the steps its host confirms.
 *
 * **Example** (Two players, one of them with no input this step)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * const both: Game.PlayerInputs<{ readonly moveX: number }> = {
 *   players: [{ moveX: 1 }, null],
 *   leaving: [],
 * };
 * both.players.length; // => 2
 * both.players[1]; // => null
 * ```
 *
 * @category models
 * @since 0.7.0
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

/**
 * The Schema `Game.PlayerInputs` returns: the players' step input, from one player's `P`.
 *
 * **When to use**
 *
 * Rarely: to type a players' input Schema written apart from the simulation that declares it.
 *
 * **Example** (The Schema's own type)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const Move = Schema.Struct({ moveX: Schema.Number });
 * const RaceInput: Game.PlayerInputsSchema<typeof Move> = Game.PlayerInputs(Move);
 * Schema.decodeUnknownSync(RaceInput)({ players: [null], leaving: [0] }).leaving; // => [0]
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
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
 *
 * **When to use**
 *
 * To type one player's source, such as what an engine's `input` reads before `soloInput` seats
 * it: `Game.PlayerInputOf<Game.InputOf<typeof Race>>`.
 *
 * **Example** (One player's input, read off the players' input)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const RaceInput = Game.PlayerInputs(Schema.Struct({ moveX: Schema.Number }));
 * const mine: Game.PlayerInputOf<typeof RaceInput.Type> = { moveX: -1 };
 * mine.moveX; // => -1
 * ```
 *
 * @category utility types
 * @since 0.7.0
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
 * **When to use**
 *
 * In a host that seats several players, to type the simulation it is handed, inferring `Input`
 * from it.
 *
 * **Details**
 *
 * A simulation with any other step input, a struct written by hand with `players` and `leaving`
 * included, is a type error that names `Game.PlayerInputs` where a host infers `Input` from the
 * simulation it is handed: `LockstepSession.host`, `playerInputSchema`, and the `Coop` builder, which
 * infers it from its engine's. Where `Input` is named
 * (`PlayersSimulation<Config, State, PlayerInputs<P>, ...>`), the types can't tell: such a
 * struct's type is a players' input's too, since the mark is optional, and the host's throw is
 * the only refusal. So a builder that is to refuse one by type takes the simulation's `Input`
 * as a type parameter, and doesn't name the step input itself.
 *
 * **Example** (A host that seats several players)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const seat = <Config, State, Input, Event, Command, Refusals>(
 *   simulation: Game.PlayersSimulation<Config, State, Input, Event, Command, Refusals>
 * ): string => simulation.simulationName;
 *
 * class Race extends Game.Simulation("Race", {
 *   input: Game.PlayerInputs(Schema.Struct({ moveX: Schema.Number })),
 *   create: () => ({}),
 *   step: () => {},
 * }) {}
 * seat(Race); // => "Race"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type PlayersSimulation<Config, State, Input, Event, Command, Refusals> =
  SimulationClass<string, Config, State, Input, Event, Command, Refusals> & {
    readonly "~types": { readonly Input: DeclaredPlayerInputs<Input> };
  };

/**
 * The step input of a simulation that several players can play, as a Schema, from the Schema of
 * one player's input: `players` holds each player's input by slot, or null for a player with no
 * input this step, and `leaving` the slots of the players removed at this step.
 *
 * **When to use**
 *
 * As the `input` of a simulation several players can play. Every host then knows how to seat
 * players: `soloInput` puts one player's devices at slot 0, and a lockstep session sends each
 * player's own input and combines them by slot.
 *
 * **Details**
 *
 * It is a Schema: `.annotate()` and `.check()` give a players' input too. A struct with the same
 * two fields written by hand is not one. A host that seats several players refuses a simulation
 * declared with it: by throwing, and before that as a type error where the host infers the step
 * input from the simulation it is handed (`PlayersSimulation` says where the types can't tell).
 *
 * **Example** (Declaring the players' input)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const HeroInput = Schema.Struct({ moveX: Schema.Number });
 * const RaceInput = Game.PlayerInputs(HeroInput);
 *
 * class Race extends Game.Simulation("Race", {
 *   input: RaceInput,
 *   create: (config: { readonly players: number }) => Array.from({ length: config.players }, () => 0),
 *   step: (xs, input) => {
 *     for (let slot = 0; slot < xs.length; slot++) {
 *       xs[slot]! += input.players[slot]?.moveX ?? 0;
 *     }
 *   },
 * }) {}
 *
 * const loop = Game.makeLoop(Race);
 * loop.start({ players: 2 }, 0, 0);
 * loop.frame({ read: () => ({ players: [{ moveX: 1 }, null], leaving: [] }) }, { steps: 3 }, 0);
 * loop.state; // => [3, 0]
 * ```
 *
 * @category schemas
 * @since 0.7.0
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
 * players sends for each of them.
 *
 * **When to use**
 *
 * In a host that seats several players, when it is made: a lockstep session reads it to encode
 * and decode what each player sends.
 *
 * **Details**
 *
 * It throws for a simulation whose `input` was not declared with `Game.PlayerInputs`: what a
 * cast, plain JavaScript or a type that names the step input gets past `PlayersSimulation`'s
 * type error.
 *
 * **Example** (Reading one player's Schema off a simulation)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Race extends Game.Simulation("Race", {
 *   input: Game.PlayerInputs(Schema.Struct({ moveX: Schema.Number })),
 *   create: () => ({}),
 *   step: () => {},
 * }) {}
 *
 * const player = Game.playerInputSchema(Race);
 * Schema.decodeUnknownSync(player)({ moveX: 1 }); // => { moveX: 1 }
 * ```
 *
 * @category getters
 * @since 0.7.0
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
 * A single player's step input from one player's source: slot 0's input, nobody leaving.
 *
 * **When to use**
 *
 * What an engine's `input` returns for a simulation several players can play, and what a replay
 * or a test steps one with.
 *
 * **Details**
 *
 * It returns one object, refilled each step, so a step allocates nothing for it. `endStep` and
 * `endFrame` reach `source`.
 *
 * **Example** (One player's source at slot 0)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * const input = Game.soloInput({ read: (step) => ({ moveX: step }) });
 * input.read(4); // => { players: [{ moveX: 4 }], leaving: [] }
 * input.read(5) === input.read(6); // => true
 * ```
 *
 * @category constructors
 * @since 0.7.0
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
