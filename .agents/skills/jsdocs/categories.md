# Categories

Every export requires one non-empty `@category`, from `CATEGORIES` in `website/src/lib/api.ts`. A module's page has a heading for each category its exports name, in the order of that list, and an export with none falls under its kind, last. Reuse nearby categories. A category that is missing is added to the list in the same change, capitalized as the others are; one that is only misspelled gets a heading of its own, after those of the list, with no error.

The categories are:

- Shapes: `Constructors` (`make`, `define`), `Models`, `Options`, `Errors`, `Schemas`, `Codecs` (`encode`, `decode`), `Guards`, `Constants`, `Type-level`, `Utilities`.
- Effect: `Services`, `Layers`, `Running`.
- A game's parts, where a module exports one ready made: `Components`, `Fields`, `Actions`, `Events`, `Views`, `Systems`, `Plugins`.
- Operations on a part: `Combinators`, `Conditions`, `Migrations`.
- Around a game: `Hosting`, `Testing`.

Keep these boundaries: services are contracts, with the shape of each, and layers provide them; constructors make a value of the module's own while running starts a program, a loop or a load; models are the data and handles a game's code holds while options are what a constructor or a run is given, and type-level exports are types that work on other types; guards narrow while conditions are what `System.runIf` is given; combinators return a changed copy of what they are given while utilities compute something else from it; `Systems`, `Plugins`, `Components`, `Actions`, `Events` and `Views` are for values a game installs or uses as they are, and what makes such a value is a constructor; what a host calls is hosting, and what only a test uses is testing.
