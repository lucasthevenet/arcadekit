import { Result, Schema } from "effect";

import { playerInputSchema } from "../../game/index";
import type { PlayerInputOf, PlayersSimulation } from "../../game/index";
import type { PeerId } from "../transport";

// What one player sends for one step of a lockstep run, how it crosses the network, and what the
// host confirms for a step. Plain on purpose, like the session that calls it: every
// peer steps on what `decode` gives, so it gives the same bits on every peer.

/**
 * Most commands one player's step carries. A player who sends more has the rest ride the next
 * steps its session schedules, in the order sent. A payload with more doesn't decode, so a
 * forged peer can't grow a step.
 */
export const MAX_STEP_COMMANDS = 4;

/**
 * One player's part of one step, decoded: what every peer steps on for that player.
 *
 * On the wire it is a JSON list: `[input]`, or `[input, command, ...]`, where `input` is the
 * one-player Schema's encoded side or null and a command its class's
 * (`{ "_tag": ..., ...fields }`). Always a list, so no input's own encoding can be taken for a
 * payload with commands.
 */
export interface StepPayload<PlayerInput, Command> {
  /** What the player's devices held for the step. Null while nothing is attached on its peer. */
  input: PlayerInput | null;
  /** The commands the player sent for the step, in the order sent. Empty on most steps. */
  commands: readonly Command[];
}

/** One player's part of one step, as every peer steps on it. */
export interface PlayerStepInput<PlayerInput, Command> extends Readonly<
  StepPayload<PlayerInput, Command>
> {
  readonly player: PeerId;
}

/**
 * Everything the host decided for one step: each player's input and commands, in player order
 * (host first), and the players removed at this step, who are absent from it on.
 */
export interface ConfirmedStep<PlayerInput, Command> {
  readonly inputs: readonly PlayerStepInput<PlayerInput, Command>[];
  readonly removed: readonly PeerId[];
}

/**
 * Turns one player's part of a step into a JSON value and back. A lockstep session makes one
 * from its simulation: the one-player Schema of its `Game.PlayerInputs`, and its commands.
 *
 * Every peer, the host included, steps on the decoded value, so a step sees the same input and
 * the same commands everywhere even where JSON loses detail (-0 becomes 0).
 */
export interface PayloadCodec<PlayerInput, Command> {
  /**
   * The wire form of a step's payload, from the player's input and the wire forms of the
   * commands riding the step (`encodeCommand`'s). It copies: a device source refills one input
   * object each step, and the session keeps the encoded value until the host has it. Throws on
   * an input the one-player Schema refuses to encode.
   */
  readonly encode: (
    input: PlayerInput | null,
    commands: readonly unknown[]
  ) => unknown;
  /**
   * Decodes a payload into `into`, the record its caller keeps of that player's step, and
   * returns null. For a value that is no payload of this simulation, as a peer on other code
   * would send, it returns why, having filled nothing: an input or a command that doesn't
   * decode, a command the simulation doesn't declare, more than `MAX_STEP_COMMANDS` of them, or
   * anything that isn't a list. It never throws. The host removes a peer whose payload fails; a
   * peer stops on a step from the host that fails.
   *
   * It fills a record where it could return one: a session decodes every player's payload of
   * every step, and keeps one record of each, so this way a payload costs no object of its own.
   */
  readonly decode: (
    encoded: unknown,
    into: StepPayload<PlayerInput, Command>
  ) => string | null;
  /**
   * A command's wire form, checked to decode again: what a sender's session keeps until the
   * command rides a step. It fails, with why, for a command no peer could decode, such as one
   * holding a NaN, which JSON carries as null.
   */
  readonly encodeCommand: (command: Command) => Result.Result<unknown, string>;
}

/** A copy of `value` as the wire carries it. */
const throughJson = (value: unknown): unknown =>
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON is the wire: it turns -0 into 0, and a copy through it keeps only what the wire carries.
  JSON.parse(JSON.stringify(value));

const NO_COMMANDS: readonly never[] = [];

const makeCodec = <PlayerInput, Command>(
  player: Schema.Codec<PlayerInput, unknown>,
  commands: readonly Schema.Codec<Command, unknown>[]
): PayloadCodec<PlayerInput, Command> => {
  const head = Schema.Tuple([Schema.NullOr(player)]);
  const command = commands.length === 0 ? undefined : Schema.Union(commands);
  const payload =
    command === undefined
      ? head
      : Schema.TupleWithRest(head, [command]).check(
          Schema.isMaxLength(1 + MAX_STEP_COMMANDS)
        );
  const encodeInput = Schema.encodeSync(player);
  const decodeInput = Schema.decodeUnknownResult(player);
  const decodePayload = Schema.decodeUnknownResult(
    // The tuple's own type lists its rest as the union's members: the same values.
    payload as unknown as Schema.Codec<
      readonly [PlayerInput | null, ...Command[]],
      unknown
    >
  );
  const encodeCommand =
    command === undefined ? undefined : Schema.encodeUnknownResult(command);
  const decodeCommand =
    command === undefined ? undefined : Schema.decodeUnknownResult(command);
  return {
    encode: (input, riding) => {
      const wire = input === null ? null : throughJson(encodeInput(input));
      return riding.length === 0 ? [wire] : [wire, ...riding];
    },
    decode: (encoded, into) => {
      // Nearly every payload is an input and nothing else, and for that one the one-player
      // Schema alone gives what the payload's Schema gives. Decoding it through the tuple and
      // its union of commands was measured at some 400 bytes more for each payload, in V8. A
      // null alone, from a peer with nothing attached, takes the long way: a case for it here
      // was measured to cost the payloads that carry an input more than it saved.
      if (
        Array.isArray(encoded) &&
        encoded.length === 1 &&
        encoded[0] !== null
      ) {
        const input = decodeInput(encoded[0]);
        if (Result.isFailure(input)) {
          return input.failure.message;
        }
        into.input = input.success;
        into.commands = NO_COMMANDS;
        return null;
      }
      const decoded = decodePayload(encoded);
      if (Result.isFailure(decoded)) {
        return decoded.failure.message;
      }
      const [input, ...sent] = decoded.success;
      into.input = input;
      into.commands = sent.length === 0 ? NO_COMMANDS : sent;
      return null;
    },
    encodeCommand: (sent) => {
      if (encodeCommand === undefined || decodeCommand === undefined) {
        return Result.fail("the simulation declares no command");
      }
      const encoded = encodeCommand(sent);
      if (Result.isFailure(encoded)) {
        return Result.fail(encoded.failure.message);
      }
      const wire = throughJson(encoded.success);
      const decoded = decodeCommand(wire);
      return Result.isFailure(decoded)
        ? Result.fail(decoded.failure.message)
        : Result.succeed(wire);
    },
  };
};

/** The codec made for each simulation, so every session of it shares one. */
const codecs = new WeakMap<object, unknown>();

/**
 * The codec of one player's step payload in a lockstep run of `simulation`. Throws for a
 * simulation whose step input was not declared with `Game.PlayerInputs`, as `playerInputSchema`
 * does.
 *
 * One codec for each simulation, however many sessions ask: a codec keeps nothing of a run, and
 * a page that plays a second run then decodes through the same functions as its first. Made
 * anew for each session, they would be new closures each run, which a JavaScript engine can't
 * treat as one known function: measured in V8, about 250 bytes more for each step a session
 * decodes.
 */
export const payloadCodec = <Config, State, Input, Event, Command, Refusals>(
  simulation: PlayersSimulation<Config, State, Input, Event, Command, Refusals>
): PayloadCodec<PlayerInputOf<Input>, Command> => {
  const made = codecs.get(simulation) as
    | PayloadCodec<PlayerInputOf<Input>, Command>
    | undefined;
  if (made !== undefined) {
    return made;
  }
  const codec = makeCodec<PlayerInputOf<Input>, Command>(
    playerInputSchema(simulation),
    // Each command's class is the Schema of its values.
    simulation.definition.commands as unknown as readonly Schema.Codec<
      Command,
      unknown
    >[]
  );
  codecs.set(simulation, codec);
  return codec;
};
