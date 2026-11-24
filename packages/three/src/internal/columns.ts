/**
 * A numeric column, as a loop reads it.
 *
 * @internal
 */
export interface Numbers {
  readonly [row: number]: number;
}
/**
 * The columns of a three-number component, as a loop reads them.
 *
 * @internal
 */
export interface Xyz {
  readonly x: Numbers;
  readonly y: Numbers;
  readonly z: Numbers;
}
/**
 * The columns of a colour.
 *
 * @internal
 */
export interface Rgb {
  readonly r: Numbers;
  readonly g: Numbers;
  readonly b: Numbers;
  readonly space: Numbers;
}
/**
 * The columns of a quaternion.
 *
 * @internal
 */
export interface Xyzw extends Xyz {
  readonly w: { readonly [row: number]: number };
}
/**
 * The columns of a 2D position or scale.
 *
 * @internal
 */
export interface Xy {
  readonly x: { readonly [row: number]: number };
  readonly y: { readonly [row: number]: number };
}
/**
 * The column of a 2D rotation.
 *
 * @internal
 */
export interface Angle {
  readonly angle: { readonly [row: number]: number };
}

/**
 * A loop over the columns of a query, whichever its terms. Typed as a method's
 * type, whose parameters are compared both ways, so that each of the loops
 * of a kind is one, and can be handed to the query it was written for.
 *
 * @internal
 */
export type Columns = { loop(...columns: unknown[]): void }["loop"];
