---
"arcadekit": minor
---

`arcadekit/Grid` is a new entry, for a game on tiles. `Grid.tiles(width, height)` is a field that holds a map, a `Grid.Tiles` of a number from 0 to 255 a tile, made by `Grid.fill` and changed into a new map by `tiles.with(x, y, value)`, so a save holds it, the hash covers it, and a refused action puts it back. `Grid.occupants(tiles, view)` works out who is on each tile from a query whose first term has an `x` and a `y`, and keeps nothing, so it is true after a move, a rewind and a load. `Grid.sides` is the four steps to the tiles beside one. Nothing breaks.
