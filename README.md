# arcadekit

A framework for building games of any genre on Effect 4, built around an entity component system.

Two packages are published from here: [`arcadekit`](packages/arcadekit), the kit, and [`@arcadekit/three`](packages/three), the plugin that draws a game with Three.js.

- [Website](https://arcadekit.dev): the walkthrough, the concepts, the guides and the reference. Its pages are in [`website/src/content/docs/`](website/src/content/docs/), and `pnpm dev:docs` serves it.
- [Roadmap](ROADMAP.md): what to build next, in order, and [what is not built yet](ROADMAP.md#not-built-yet), with [what it waits on](roadmap/decisions.md) and [what to revisit before a stable release](roadmap/to-revisit.md).
- [AGENTS.md](AGENTS.md): how to work on the repository, and which skill of [`.agents/skills/`](.agents/skills/) a kind of work reads.

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
