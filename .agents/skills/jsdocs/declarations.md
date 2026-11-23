# Tags, modules, and links

## Declaration shape

Use a multiline doc comment for a public declaration:

```ts sketch
/**
 * Short description as one paragraph.
 *
 * **When to use**
 *
 * Optional practical usage guidance.
 *
 * **Details**
 *
 * Optional details for complex behavior.
 *
 * **Gotchas**
 *
 * Optional concrete caveats.
 *
 *   const phase = yield* Phase
 *   phase.set("playing") // entered at the start of the next tick
 *
 * @category Models
 */
```

Write practical English about the public concept, not its implementation. Start functions and methods with a present-tense action such as `Makes`, `Returns`, or `Asks for`; match nearby noun families for values, such as `A system's handle to`, `The layer that`, or `What a tick fails with when`.

Optional non-empty sections appear once in this order: `**When to use**`, `**Details**`, `**Gotchas**`. Separate descriptions, sections, examples, and tags with exactly one blank line. Do not add other headings.

`**When to use**` states a positive use case distinct from the description and begins with `Use to`, `Use when`, `Use as`, or `Use with`. It is also where a close alternative is named, in code formatting, with which of the two to use when. Reserve `**Gotchas**` for concrete preconditions, edge cases, surprising behavior, and important failure modes. A gotcha that nothing stops, in the types or at run time, is also an issue labelled `silent-failure`, as `AGENTS.md` says.

No doc comment explains a workaround or why the right thing was not done.

## Tags

The reference reads four tags, and they come after the text in this order:

1. `@param` and `@typeParam`
2. `@category`
3. `@internal`

- Every export requires one non-empty `@category`: see [categories.md](categories.md).
- `@param name text` and `@typeParam name text` are for what a name and its type do not say, most often a type's parameters. The page shows them as a list. Leave them out where the signature is enough.
- `@internal` marks an export that another module of the package needs and a game does not use. No page lists it, and it takes no `@category`.
- Use no other tag. The page drops a tag it does not read, with no error: `@since`, `@stability`, `@deprecated`, `@see`, `@returns` and `@example` say nothing there. The packages are alpha, and an export says neither when it came nor how long it will stay.
- Member doc comments, on a field of an interface or of an options object, are optional. When present they are a sentence or two, with no tag, and follow the prose contract.

## Modules and links

The first doc comment of a source file, above its imports, is the module's: its page starts with it. It says what the module is for in a sentence, shows the module in use in one example, then says what a reader has to know before using any of it. It has no tags and does not use the declaration template.

Inline `{@link Symbol}` is not resolved: the page shows it as it is written. Write a symbol in code formatting, with its namespace, `` `State.onEnter` ``, and use normal Markdown links for URLs. Name another export only when it helps a reader understand or choose the API: a close alternative, an inverse, or the type a function returns, consumes or configures.
