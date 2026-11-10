import { Effect, Schema } from "effect";

import * as Game from "../../game/index";
import type { GameView } from "../../runtime/browser";
import type { InputSource } from "../../runtime/index";
import type { CoopGame, CoopPresentation } from "../browser/index";
import type { CoopRules, CoopTypes } from "../coop";

// A small Co-op game for tests: every player adds a number each step, and now and then the run
// stops on an offer that each player answers. It is enough to drive every part of the Co-op
// client: lobby picks, an answer held until it settles, players choosing, pause, and a run's end.
// Its rules are declared as a genre's are: events, then the simulation that reports them. Each
// declaration's base is named first, with its type, since the kit's type files are made one file
// at a time (isolatedDeclarations).

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
}

const ScoreBase: Game.EventClass<
  "Score",
  {
    readonly steps: Schema.Int;
    readonly totals: Schema.$Array<Schema.Number>;
  }
> = Game.Event("Score", {
  steps: Schema.Int,
  totals: Schema.Array(Schema.Number),
});

/** The run's sample, every 100 ms: the steps played, and each player's total by slot. */
export class Score extends ScoreBase {}

const OfferOpenedBase: Game.EventClass<
  "OfferOpened",
  { readonly offer: Schema.Int; readonly slot: Schema.Int }
> = Game.Event("OfferOpened", { offer: Schema.Int, slot: Schema.Int });

/** Offer `offer` opened for `slot`'s player. */
export class OfferOpened extends OfferOpenedBase {}

const RunEndedBase: Game.EventClass<
  "RunEnded",
  { readonly totals: Schema.$Array<Schema.Number> }
> = Game.Event("RunEnded", { totals: Schema.Array(Schema.Number) });

/** The run ended. `totals` is each player's total plus bonus, by slot. */
export class RunEnded extends RunEndedBase {}

/** Everything a run of the test game reports: its two events and its sample. */
export type TestEvent = Score | OfferOpened | RunEnded;

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
  players: readonly (TestInput | null)[],
  report: (event: OfferOpened | RunEnded) => void
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
    report(
      new RunEnded({
        totals: state.totals.map((total, slot) => total + state.bonus[slot]!),
      })
    );
  } else if (offerEvery > 0 && state.steps % offerEvery === 0) {
    state.offer += 1;
    for (let slot = 0; slot < state.owes.length; slot++) {
      if (state.gone[slot] !== true) {
        state.owes[slot] = true;
        report(new OfferOpened({ offer: state.offer, slot }));
      }
    }
  }
};

const TestGameBase: Game.SimulationClass<
  "TestGame",
  TestConfig,
  TestState,
  Game.PlayerInputs<TestInput>,
  TestEvent,
  never,
  Game.RefusalsOf<readonly []>
> = Game.Simulation("TestGame", {
  input: Game.PlayerInputs(TestInputSchema),
  events: [OfferOpened, RunEnded],
  create: ({ content, picks }: TestConfig): TestState => ({
    content,
    picks,
    steps: 0,
    totals: picks.map(() => 0),
    bonus: picks.map(() => 0),
    offer: 0,
    owes: picks.map(() => false),
    gone: picks.map(() => false),
    ended: false,
  }),
  step: (state, input, { report }) => {
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
      advance(state, input.players, report);
    }
  },
  sample: {
    event: Score,
    every: "100 millis",
    read: (state) => ({ steps: state.steps, totals: [...state.totals] }),
  },
});

/**
 * The test game's rules: plain and deterministic, as a genre's are. Several players play it, so
 * its step input is a `Game.PlayerInputs`; an answer and a pause ride each player's input.
 */
export class TestGame extends TestGameBase {}

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

/** The test game's lockstep parts. */
export const testCoopRules: CoopRules<TestCoop> = {
  simulation: TestGame,
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
    switch (event._tag) {
      case "Score": {
        return {
          type: "score",
          steps: event.steps,
          total: event.totals[slot] ?? 0,
        };
      }
      case "OfferOpened": {
        return event.slot === slot
          ? { type: "offer", offer: event.offer }
          : null;
      }
      case "RunEnded": {
        return { type: "ended", total: event.totals[slot] ?? 0, names };
      }
    }
  },
  runEnded: (event) => event._tag === "RunEnded",
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
