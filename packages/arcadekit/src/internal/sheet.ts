import type { Layer } from "effect";

import type { Clip, Plays, Sheet } from "../Sound.ts";

/**
 * What a clip of a cue sheet holds: the sheet it is in, and the file a page
 * fetches for it, or what another clip it names plays.
 *
 * @internal
 */
export class Entry {
  constructor(
    readonly sheet: string,
    /** The file's URL, for a sound the sheet gave as one. */
    readonly url: string | undefined,
    /** What is played, for a sound the sheet gave as a clip, such as a stream. */
    readonly data: unknown
  ) {}
}

/**
 * The sounds of each sheet, which only `Sound.Clips` gives a game, and
 * which a page reads to fetch their files.
 *
 * @internal
 */
export const soundsOf = new WeakMap<Sheet, Readonly<Record<string, Clip>>>();

/**
 * Says of a layer that what it provides plays the sheets of `P`. `Plays`
 * stands for nothing at run time, so nothing else is provided.
 *
 * @internal
 */
export const playing = <P extends Plays<string>>(
  layer: Layer.Layer<never>
): Layer.Layer<P> => layer as Layer.Layer<P>;
