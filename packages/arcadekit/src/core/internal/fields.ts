// What an entity pool, a ring and a tile map share, and no game calls: the typed arrays of a
// layout's fields, made once when the structure is.

import type * as Layout from "../layout";

/** A field's array, whichever typed array its layout names. */
export type FieldArray = InstanceType<Layout.Layout[string]>;

/** One typed array of `length` for each field of `layout`, every element 0, under its name. */
export const allocate = <L extends Layout.Layout>(
  layout: L,
  length: number
): Layout.Fields<L> =>
  Object.fromEntries(
    Object.entries(layout).map(([name, ArrayType]) => [
      name,
      new ArrayType(length),
    ])
  ) as unknown as Layout.Fields<L>;

/**
 * The arrays of `fields`, in the order `Object.values` lists them, so a structure that writes
 * every field of a slot walks them without making the list each time.
 */
export const arraysOf = <L extends Layout.Layout>(
  fields: Layout.Fields<L>
): readonly FieldArray[] => Object.values(fields) as FieldArray[];
