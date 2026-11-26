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
