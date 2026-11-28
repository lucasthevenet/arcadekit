/**
 * The types that keep a relation's `target` the world's: it is read like any
 * field, and written only by adding the relation again.
 *
 * No Effect dependency.
 */
import type {
  ComponentDef,
  Entity,
  FieldDef,
  ReadonlyColumn,
  Schema,
} from "./component.ts";

declare const TargetBrand: unique symbol;
declare const RetargetBrand: unique symbol;

/**
 * A relation's `target` field, the id of an entity that the world keeps track
 * of. A loop reads it like any field and cannot assign it. It differs from a
 * `Field.entity` only in its type.
 *
 * @category Models
 */
export interface TargetField extends FieldDef<Entity, ReadonlyColumn<Entity>> {
  /** Holds no value. It tells the field apart from a `Field.entity` in the type. */
  readonly [TargetBrand]: true;
}

/** A relation's fields: its target, then any of its own. */
export type RelationSchema<S extends Schema> = {
  readonly target: TargetField;
} & S;

/**
 * A relation's definition, as `Component.relation` returns it. It is a
 * component whose `target` the world keeps track of, and `World.sources`
 * takes one.
 *
 * @category Models
 */
export type RelationDef = ComponentDef<{ readonly target: TargetField }>;

/**
 * The fields of a component that `World.set` takes: any of them, except a
 * relation's `target`. A relation gets a new target when it is added again.
 *
 * @category Type-level
 */
export type PatchOf<S extends Schema> = {
  -readonly [K in keyof S]?: S[K] extends TargetField
    ? Retarget
    : S[K] extends FieldDef<infer T, unknown>
      ? T
      : never;
};

/** What `set` is told of a relation's `target`: a message, which no value is. */
type Retarget =
  "A relation's target is not set like a field: add the relation again, with its .of({ target }), on Commands or on the world." & {
    readonly [RetargetBrand]: true;
  };

/**
 * The row `each` hands out of a component a query writes: its value, with a
 * relation's `target` read-only.
 */
export type RowOf<S extends Schema> = {
  -readonly [
    K in keyof S as S[K] extends TargetField ? never : K
  ]: S[K] extends FieldDef<infer T, unknown> ? T : never;
} & {
  readonly [K in keyof S as S[K] extends TargetField ? K : never]: Entity;
};

/** The last part of a component's name: `Owes` of `"bank/Owes"`. */
type LastPart<N extends string> = N extends `${string}/${infer R}`
  ? LastPart<R>
  : N;

/**
 * What `spawn` and `add` are told of a relation given bare, with no target,
 * and `unknown` for any other input.
 */
export type Targeted<I> = I extends {
  readonly schema: { readonly target: TargetField };
  readonly name: infer N extends string;
}
  ? `"${N}" is a relation, and a relation needs a target: give it as ${LastPart<N>}.of({ target }).`
  : unknown;
