# Designing a feature

## Few rules for the author

An API costs a game's author what they must learn to use it right, not the number of its functions. Before adding an export or an option, list those rules: when to choose it over what the package already has, what it does that its call does not show, what it changes in code that does not use it, and what goes wrong with no error. Keep the list short:

- **One way to do a thing.** When what exists covers the case, such as a state, a run condition or a system, use it, and say on its page how. A second way gives every author a choice to learn.
- **Nothing the call does not show.** A call that also acts elsewhere, such as stopping what depends on it, or a fork that lives as long as whatever started it, is a rule to learn. Prefer one that does only what it says, and let the author ask for the rest.
- **No new way to fail for code that did not change.** A feature that gives existing calls a new error costs every game, not only those that use it.
- **Built when something needs it.** A feature with only an imagined use waits until a game, an example or another feature needs it. That use shows which of its rules are worth having.

When the list is long beside what the feature gives, cut the feature back, or show the owner the design and its list before building it. No check can weigh this, so the pull request lists the rules a reviewer weighs. Stopping a plugin at run time was cut from #217 this way: a state covered its uses, and it came with five rules.

## Learning from other engines

Before designing a complex feature (change detection, hierarchies, scheduling, relations, states, physics, networking), find out how established engines and ECS frameworks solved it. [Bevy](https://bevy.org/) is the first place to look: it is an ECS built around systems, queries, commands, events, resources and plugins, as this package is, and its design discussions and [examples](https://github.com/bevyengine/bevy/tree/main/examples) say why each part works the way it does and what was tried before. Other engines and ECS libraries are worth reading for the same reason.

- **Borrow the design, not the API.** What is worth taking is which problems a feature has to solve, the cases it has to handle and the mistakes the engine made on the way. The interface is then written the way this guide says, with Effect's idioms, not translated from Rust or C++.
- **The rules here still hold.** A design borrowed from elsewhere still has to keep a tick deterministic, change the set of entities only through `Commands`, run one Effect per system and not per entity, and keep the storage core free of Effect. Where another engine's design breaks one of these, the design changes, not the rule.
- **Say where it came from.** Name the engine and link the part of it that was used, in the pull request and, when it explains a choice the code makes, in a comment.
