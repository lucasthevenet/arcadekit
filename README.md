# arcadekit

A framework for building games of any genre on Effect 4, built around an entity component system.

This is the `next` branch: a revamped arcadekit, designed fresh. The package lives in `packages/arcadekit`; its [README](packages/arcadekit/README.md) describes the design, what works and what is not done yet. [`@arcadekit/three`](packages/three/README.md), in `packages/three`, is the plugin that draws a game with Three.js. The previous version is on `main`.

- [Conventions](docs/conventions.md): how code here is written, with references into Effect's documentation.
- [Roadmap](docs/roadmap.md): what to build next, in order.
- [The docs site](website/README.md): a guide, the concepts and the reference, from `docs/` and the packages' READMEs. `pnpm dev:docs` serves it.

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
