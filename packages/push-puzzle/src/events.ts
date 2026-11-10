import * as Game from "arcadekit/game";
import { Schema } from "effect";

// What a push-puzzle run reports. Each is a class and its own Schema, so an app uses it in its
// Model and Messages, and a field added here reaches the app.

/** What the HUD shows: the run's sample, reported at the start and after every turn. */
export class Hud extends Game.Event("Hud", {
  moves: Schema.Number,
  /** Goals that have no box on them yet. */
  boxesLeft: Schema.Number,
}) {}

/** The level is solved: every goal has a box, after this many moves. */
export class LevelSolved extends Game.Event("LevelSolved", {
  moves: Schema.Number,
}) {}
