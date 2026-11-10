import { Effect, Schema } from "effect";

import type { GameView } from "../../runtime/browser";
import type {
  GameSimulation,
  InputSource,
  PlayerInputs,
} from "../../runtime/index";
import type { CoopGame, CoopPresentation } from "../browser/index";
import { schemaCodec } from "../codec";
import type { InputCodec } from "../codec";
import type { CoopRules, CoopTypes } from "../coop";

// A small Co-op game for tests: every player adds a number each step, and now and then the run
// stops on an offer that each player answers. It is enough to drive every part of the Co-op
// client: lobby picks, an answer held until it settles, players choosing, pause, and a run's end.

/** The test game's content, as JSON data. */
export interface TestContent {
  /** The valid lobby picks. */
  readonly picks: readonly string[];
  /** The run ends after this many steps. */
  readonly length: number;
  /** An offer opens after every this many steps; 0 for none. */
  readonly offerEvery: number;
}

/** Three picks, a run that outlasts any test, and no offers. */
export const testContent: TestContent = {
  picks: ["red", "green", "blue"],
  length: 1_000_000,
  offerEvery: 0,
};

export interface TestConfig {
  readonly content: TestContent;
  /** Each player's lobby pick, by slot. */
  readonly picks: readonly string[];
}

/** A player's answer to offer `offer`: `value` is added to its bonus. */
export interface TestAnswer {
  readonly offer: number;
  readonly value: number;
}

/** One player's input for one step. */
export interface TestInput {
  /** Added to the player's total this step. */
  readonly add: number;
  readonly answer?: TestAnswer;
  readonly paused?: boolean;
}

export interface TestState {
  readonly content: TestContent;
  /** Each player's lobby pick, by slot. */
  readonly picks: readonly string[];
  steps: number;
  /** Each player's sum of `add`, by slot. */
  readonly totals: number[];
  /** Each player's sum of answered values, by slot. */
  readonly bonus: number[];
  /** The number of the last offer opened; 0 before the first. */
  offer: number;
  /** Whether each player still owes the open offer an answer, by slot. The run waits on them. */
  readonly owes: boolean[];
  /** Whether each player has left the run, by slot. */
  readonly gone: boolean[];
  ended: boolean;
  events: TestEvent[];
}

export type TestEvent =
  /** The run's sample, every 100 ms. */
  | {
      readonly type: "score";
      readonly steps: number;
      readonly totals: readonly number[];
    }
  /** Offer `offer` opened for `slot`'s player. */
  | { readonly type: "offer"; readonly offer: number; readonly slot: number }
  /** The run ended. `totals` is each player's total plus bonus, by slot. */
  | { readonly type: "ended"; readonly totals: readonly number[] };

/** What the local player hears of the run. */
export type TestLocalEvent =
  | { readonly type: "score"; readonly steps: number; readonly total: number }
  | { readonly type: "offer"; readonly offer: number }
  | {
      readonly type: "ended";
      readonly total: number;
      readonly names: readonly string[];
    };

/** The test game's types, as the bag a Co-op game names. */
export interface TestCoop extends CoopTypes {
  readonly Config: TestConfig;
  readonly State: TestState;
  readonly Event: TestEvent;
  readonly PlayerInput: TestInput;
  readonly Answer: TestAnswer;
  readonly LocalEvent: TestLocalEvent;
  readonly Content: TestContent;
}

const TestInputSchema = Schema.Struct({
  add: Schema.Number,
  answer: Schema.optionalKey(
    Schema.Struct({ offer: Schema.Number, value: Schema.Number })
  ),
  paused: Schema.optionalKey(Schema.Boolean),
});

const nothing = (): void => undefined;

/** The run waits on an offer: only its answers count. */
const answerOffer = (
  state: TestState,
  players: readonly (TestInput | null)[]
): void => {
  for (let slot = 0; slot < players.length; slot++) {
    const answer = players[slot]?.answer;
    if (
      state.owes[slot] === true &&
      answer !== undefined &&
      answer.offer === state.offer
    ) {
      state.bonus[slot]! += answer.value;
      state.owes[slot] = false;
    }
  }
};

/** Whether a player still in the run holds the pause. */
const pausedAny = (
  state: TestState,
  players: readonly (TestInput | null)[]
): boolean => {
  for (let slot = 0; slot < players.length; slot++) {
    if (state.gone[slot] !== true && players[slot]?.paused === true) {
      return true;
    }
  }
  return false;
};

/** One step of play: every player's `add`, then the end, or the next offer. */
const advance = (
  state: TestState,
  players: readonly (TestInput | null)[]
): void => {
  state.steps += 1;
  for (let slot = 0; slot < players.length; slot++) {
    if (state.gone[slot] !== true) {
      state.totals[slot]! += players[slot]?.add ?? 0;
    }
  }
  const { length, offerEvery } = state.content;
  if (state.steps >= length) {
    state.ended = true;
    state.events.push({
      type: "ended",
      totals: state.totals.map((total, slot) => total + state.bonus[slot]!),
    });
  } else if (offerEvery > 0 && state.steps % offerEvery === 0) {
    state.offer += 1;
    for (let slot = 0; slot < state.owes.length; slot++) {
      if (state.gone[slot] !== true) {
        state.owes[slot] = true;
        state.events.push({ type: "offer", offer: state.offer, slot });
      }
    }
  }
};

/** The test game's simulation: plain and deterministic, as a genre's is. */
export const testSimulation: GameSimulation<
  TestConfig,
  TestState,
  PlayerInputs<TestInput>,
  TestEvent
> = {
  create: ({ content, picks }) => ({
    content,
    picks,
    steps: 0,
    totals: picks.map(() => 0),
    bonus: picks.map(() => 0),
    offer: 0,
    owes: picks.map(() => false),
    gone: picks.map(() => false),
    ended: false,
    events: [],
  }),
  step: (state, input) => {
    if (state.ended) {
      return;
    }
    for (const slot of input.leaving) {
      state.gone[slot] = true;
      state.owes[slot] = false;
    }
    if (state.owes.includes(true)) {
      answerOffer(state, input.players);
    } else if (!pausedAny(state, input.players)) {
      advance(state, input.players);
    }
  },
  drainEvents: (state) => {
    const drained = state.events;
    state.events = [];
    return drained;
  },
  sample: {
    everyMs: 100,
    read: (state) => ({
      type: "score",
      steps: state.steps,
      totals: [...state.totals],
    }),
  },
};

const mix = (hash: number, value: number): number =>
  Math.imul(hash ^ value, 0x01_00_01_93) >>> 0;

/** A digest of everything in the state that a step changes. */
export const hashTestState = (state: TestState): number => {
  let hash = mix(mix(0x81_1c_9d_c5, state.steps), state.offer);
  for (let slot = 0; slot < state.totals.length; slot++) {
    hash = mix(hash, state.totals[slot]!);
    hash = mix(hash, state.bonus[slot]!);
    hash = mix(hash, state.owes[slot] === true ? 1 : 0);
    hash = mix(hash, state.gone[slot] === true ? 1 : 0);
  }
  return mix(hash, state.ended ? 1 : 0);
};

const testCodec: InputCodec<TestInput> = schemaCodec(TestInputSchema);

/** The test game's lockstep parts. */
export const testCoopRules: CoopRules<TestCoop> = {
  simulation: testSimulation,
  codec: testCodec,
  hash: hashTestState,
  picks: (content) => content.picks,
  config: (content, picks) => ({ content, picks }),
  localInput: () => {
    const input: { add: number; answer?: TestAnswer; paused?: boolean } = {
      add: 0,
    };
    return (device, answer, paused) => {
      input.add = device === null ? 0 : device.add;
      if (answer === null) {
        delete input.answer;
      } else {
        input.answer = answer;
      }
      if (paused) {
        input.paused = true;
      } else {
        delete input.paused;
      }
      return input;
    };
  },
  settled: (answer, state, slot) =>
    state.offer !== answer.offer || state.owes[slot] !== true,
  choosing: (state, slot) => state.owes[slot] === true,
  localEvent: (event, slot, names) => {
    switch (event.type) {
      case "score": {
        return {
          type: "score",
          steps: event.steps,
          total: event.totals[slot] ?? 0,
        };
      }
      case "offer": {
        return event.slot === slot
          ? { type: "offer", offer: event.offer }
          : null;
      }
      case "ended": {
        return { type: "ended", total: event.totals[slot] ?? 0, names };
      }
    }
  },
  runEnded: (event) => event.type === "ended",
};

const ADD_ONE: TestInput = { add: 1 };

/**
 * The test game's presentation: an input that adds 1 each step while attached, and a view that
 * draws nothing. Pass `createInput` or `createView` to watch or replace either.
 */
export const testPresentation = (
  parts: Partial<CoopPresentation<TestState, TestInput>> = {}
): CoopPresentation<TestState, TestInput> => ({
  createInput: (): InputSource<TestInput> => ({
    read: () => ADD_ONE,
    dispose: nothing,
  }),
  createView: (): GameView<TestState> => ({
    render: nothing,
    dispose: nothing,
  }),
  ...parts,
});

export interface TestCoopGameOptions<LoadError = never> {
  /** The content each seat loads. Defaults to `testContent`, at once. */
  readonly content?: Effect.Effect<TestContent, { readonly message: string }>;
  /** What each attach makes. Defaults to `testPresentation()`, at once. */
  readonly presentation?: Effect.Effect<
    CoopPresentation<TestState, TestInput>,
    LoadError
  >;
  readonly maxPlayers?: number;
  readonly lockstep?: CoopRules<TestCoop>["lockstep"];
}

/** The test game as a Co-op game: `testCoopRules`, with content and a presentation from `options`. */
export const testCoopGame = <LoadError = never>(
  options: TestCoopGameOptions<LoadError> = {}
): CoopGame<TestCoop, LoadError> => ({
  ...testCoopRules,
  ...(options.maxPlayers === undefined
    ? {}
    : { maxPlayers: options.maxPlayers }),
  ...(options.lockstep === undefined ? {} : { lockstep: options.lockstep }),
  content: options.content ?? Effect.succeed(testContent),
  presentation:
    options.presentation ??
    Effect.sync((): CoopPresentation<TestState, TestInput> =>
      testPresentation()
    ),
});
