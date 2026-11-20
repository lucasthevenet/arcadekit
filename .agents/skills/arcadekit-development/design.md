# Design

When creating or changing an API, avoid nuanced solutions that require deep knowledge of the library's internals to use correctly. If a game's author cannot use it right from its name, its types and its doc comment, make the design simpler.

## Learning from other engines

Before designing a complex feature (change detection, hierarchies, scheduling, relations, states, physics, networking), find out how established engines and ECS frameworks solved it. [Bevy](https://bevy.org/) is the first place to look: it is an ECS built around systems, queries, commands, events, resources and plugins, as this package is, and its design discussions and [examples](https://github.com/bevyengine/bevy/tree/main/examples) say why each part works the way it does and what was tried before. Other engines and ECS libraries are worth reading for the same reason.

- **Borrow the design, not the API.** What is worth taking is which problems a feature has to solve, the cases it has to handle and the mistakes the engine made on the way. The interface is then written the way this guide says, with Effect's idioms, not translated from Rust or C++.
- **The rules here still hold.** A design borrowed from elsewhere still has to keep a tick deterministic, change the set of entities only through `Commands`, run one Effect per system and not per entity, and keep the storage core free of Effect. Where another engine's design breaks one of these, the design changes, not the rule.
- **Say where it came from.** Name the engine and link the part of it that was used, in the pull request and, when it explains a choice the code makes, in a comment.
