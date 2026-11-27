/**
 * Components are the data of an entity: a component with fields, a tag that
 * marks an entity, or a relation that points at another entity.
 *
 *   const Position = Component.define("physics/Position", { x: Field.f32, y: Field.f32 })
 *   const Frozen = Component.tag("physics/Frozen")
 *   const ChildOf = Component.relation("scene/ChildOf", { onTargetDespawn: "despawn" })
 *
 *   commands.spawn(Position.of({ x: 0, y: 0 }), Frozen)
 *
 * A component's name is its identity in a world and in a save. Data the world
 * holds once, beside its entities, is a singleton, which `Singleton.define`
 * makes.
 */
import { Component } from "./ecs/component.ts";
import type { ComponentDef, Schema, Storage } from "./ecs/component.ts";
import type { RelationDef } from "./ecs/relation.ts";

/**
 * A component's definition, as `Component.define`, `Component.tag` and
 * `Component.relation` return it. A query names it as a term, and
 * `Position.of({ x: 0, y: 0 })` pairs it with a value for `spawn` and `add`.
 * It is the storage core's `ComponentDef`.
 *
 * @typeParam S its fields, by name
 * @typeParam St where its data is stored
 * @typeParam N its name, which the compiler reads
 * @typeParam R the names of the components a spawn or an add of it fills in
 *
 * @category Models
 */
export type Component<
  S extends Schema = Schema,
  St extends Storage = Storage,
  N extends string = string,
  R extends string = string,
> = ComponentDef<S, St, N, R>;

/**
 * A relation's definition, as `Component.relation` returns it: a component
 * whose `target` the world keeps track of. `World.sources` takes one.
 *
 * @category Models
 */
export type Relation = RelationDef;

/**
 * Defines a component with data. Each numeric field is a column of a typed
 * array.
 *
 * `name` is the component's identity in a world and in a save, a literal
 * the compiler reads: a name typed `string` doesn't compile. Prefix it
 * with the feature it belongs to, as in `"physics/Position"`. A world that
 * meets two different components with the same name throws when it meets
 * the second. `storage: "sparse"` keeps the component in a set of its own,
 * for one that is added and removed often or that few entities have.
 *
 * A component added or spawned bare, with no value, is all zeros, but for
 * each `json`, `ref` or `schema` field, which holds the initial value it was
 * made with. Give `initial` to a component whose zeros are wrong, such as a
 * size: `{ initial: { x: 1, y: 1 } }`.
 *
 * `requires` lists the components a spawn or an add of this one fills in
 * when the entity lacks them, each bare or with a value:
 *
 *   const Rock = Component.define("game/Rock", { hp: Field.i32 }, {
 *     requires: [Transform3d.Position, Transform3d.Scale.of({ x: 2, y: 2, z: 2 })],
 *   })
 *
 * - What they require is filled in too. Of two values for one component,
 *   the one given at the spawn wins, then one written in `requires` over
 *   one it inherits, then the later.
 * - An add fills in only what the entity lacks, so adding the component
 *   again gives back a requirement that was removed. Removing a required
 *   component is allowed, and leaves this one.
 * - `Commands.spawns` names what it fills in, for the order of systems.
 * - A relation can't be required, and neither can a singleton.
 * - A save holds what was filled in, and loading one fills nothing in. A
 *   replay recorded before a component required something drifts from a
 *   game that fills it in.
 *
 * @category Constructors
 */
export const define = Component.define;

/**
 * Defines a relation, a component that points at another entity, its
 * `target`, and stays correct when that entity is despawned.
 *
 *   const ChildOf = Component.relation("scene/ChildOf", { onTargetDespawn: "despawn" })
 *   world.spawn(Position.of({ x: 0, y: 0 }), ChildOf.of({ target: parent }))
 *
 * `onTargetDespawn` says what a target's despawn does to the entities that
 * point at it. `"despawn"` despawns them too, as children go with their
 * parent. `"remove"` removes the relation from them and leaves them alive,
 * as for a relation to a target or an owner. Either way, nothing is left
 * pointing at a despawned entity.
 *
 * `fields` are the relation's own fields, beside `target`, and are written
 * like any others. The target is not:
 *
 * - To change the target, add the relation again, as in
 *   `add(entity, ChildOf.of({ target }))`. The target is read-only in
 *   `each`, in `set` and in its raw column, so an assignment doesn't
 *   compile.
 * - The target must be alive. A relation given bare, with no target,
 *   doesn't compile, on `Commands` or on the world. Given a target that is
 *   already despawned, the world does at once what that despawn would have
 *   done: the holder is despawned, or the relation isn't added.
 * - An entity has one target per relation. For another kind of link, define
 *   another relation.
 *
 * @category Constructors
 */
export const relation = Component.relation;

/**
 * Defines a tag, a component with no fields. A query uses a tag only to
 * filter entities. `requires` is as `Component.define` takes it.
 *
 * @category Constructors
 */
export const tag = Component.tag;
