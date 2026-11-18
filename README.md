# arcadekit

A framework for building games of any genre on Effect 4, built around an entity component system.

A revamped arcadekit, designed fresh. The package lives in `packages/arcadekit`; its [README](packages/arcadekit/README.md) describes the design, what works and what is not done yet. [`@arcadekit/three`](packages/three/README.md), in `packages/three`, is the plugin that draws a game with Three.js.

- [How code here is written](.agents/skills/arcadekit-development/SKILL.md): the `arcadekit-development` skill, with references into Effect's documentation. [AGENTS.md](AGENTS.md) says which skill a kind of work reads.
- [Roadmap](ROADMAP.md): what to build next, in order, with [what it waits on](roadmap/decisions.md) and [what to revisit before a stable release](roadmap/to-revisit.md).
- [The docs site](website/README.md): a walkthrough, the concepts, the guides and the reference. `pnpm dev:docs` serves it.

## Development

```sh
pnpm install
pnpm check      # lint and format
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
