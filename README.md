# arcadekit

A framework for building games of any genre on Effect 4, built around an entity component system.

Two packages are published from here: [`arcadekit`](packages/arcadekit), the kit, and [`@arcadekit/three`](packages/three), the plugin that draws a game with Three.js.

- [Website](https://arcadekit.dev): the walkthrough, the concepts, the guides and the reference. Its pages are in [`website/src/content/docs/`](website/src/content/docs/), and `pnpm dev:docs` serves it.
- [Roadmap](https://github.com/lucasthevenet/arcadekit/issues/173): what to build next, in order, what is not built yet, and what to revisit before a stable release. Each piece of it is an issue.
- [AGENTS.md](AGENTS.md): the repository's layout and commands.

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
