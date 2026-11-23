# API reference

The reference lists packages, then each package’s modules from their doc comments. Readers open the index, a package page, and a module page.

## Sub-features

- `reference-index` opens `/reference` and lists packages.
- `reference-package` opens `/reference/arcadekit` (or `three`) with a modules list.
- `reference-module` opens a module page such as `/reference/arcadekit/Sound` with category headings.

## How to get to it (user POV)

- Choose `Reference` in the topic strip.
- Choose `Browse the API reference` on the landing page.
- Choose a package or module link from the reference sidebar or package page.
- Open `/reference`, `/reference/arcadekit`, or `/reference/arcadekit/Sound` directly.

## Driving it with control-docs

Preconditions:

- Docs are healthy at the launch URL.
- Packages were built as part of `control-docs launch` so module pages exist from `dist/*.d.ts`.

- **Index.** Open the reference index. Run `control-docs browser goto --path /reference`. The heading accessible name is `API Reference` and a link toward `/reference/arcadekit` is present.
- **Package.** Open the arcadekit package page. Run `control-docs browser click --role link --name "arcadekit"` from the index, or `control-docs browser goto --path /reference/arcadekit`. The page lists module links including `Sound` and `Query`.
- **Module.** Open Sound. Run `control-docs browser click --role link --name "Sound"`. URL ends with `/reference/arcadekit/Sound` and the heading is `Sound`. Category headings such as `Constructors` or `Plugins` appear.
- **Proof.** Capture the module page. Run `control-docs browser snapshot --aria --path artifacts/reference/sound.aria.txt` and `control-docs browser screenshot --path artifacts/reference/sound.png`. Artifacts show heading `Sound` and at least one category heading.

## Gotchas

- Module pages are generated from built declarations. If Sound 404s, the launch skipped a needed build; re-run without `--skip-build`.
- Several links may be named `Sound` (sidebar and body). Prefer navigating after `goto --path /reference/arcadekit` so the first match is the module link, or use `goto --path /reference/arcadekit/Sound` for the module itself.
- The package name in the header version chip is not a reference link; use sidebar or body links.
