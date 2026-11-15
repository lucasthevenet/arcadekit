/**
 * A helper type for declaring error classes.
 */
import type { Cause } from "effect";

/**
 * The constructor that `Data.TaggedError(tag)<Fields>` returns, spelled out.
 *
 * The usual one-line form, `class X extends Data.TaggedError("X")<F> {}`,
 * has a call in its `extends` clause, which the build's declaration generator
 * cannot type one file at a time (isolatedDeclarations). So an error class
 * here extends a constant that has this type:
 *
 *   const Base: TaggedErrorClass<"X", F> = Data.TaggedError("X");
 *   export class X extends Base {}
 */
export type TaggedErrorClass<Tag extends string, Fields extends object> = new (
  args: Fields
) => Cause.YieldableError & { readonly _tag: Tag } & Readonly<Fields>;
