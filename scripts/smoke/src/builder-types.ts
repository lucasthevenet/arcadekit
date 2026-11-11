// What a package built on the kit meets when it emits its types (`declaration` in
// tsconfig.json): its type files name every type its exports have, and can name only what an
// entry of the kit exports. A builder's own type names each type its definition takes, so a
// line below is an error if no entry this project imports exports one of them, such as
// `NoHandlers`, which only the builder's type names.
import * as Sound from "arcadekit/audio";
import * as Game from "arcadekit/game";
import * as Kept from "arcadekit/save";

export const Rules = Game.Simulation;
export const Records = Kept.Save;
export const Apart = Kept.Setting;
export const Cues = Sound.CueTable;
