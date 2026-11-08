# @arcadekit/render-three

## 0.2.3

### Patch Changes

- [#62](https://github.com/lucasthevenet/arcadekit/pull/62) [`ec25311`](https://github.com/lucasthevenet/arcadekit/commit/ec25311c214f6a9fd367a73565b62d10b30217bb) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Stage.dispose()` releases its WebGL context (`forceContextLoss`). It used to leave the context alive until the canvas was collected, so a game that makes stages one after another (a view per attach) piled them up. Chrome keeps 16 a page and then kills the oldest, which can be a live stage's, and a page that keeps losing them can be refused new ones ("Error creating WebGL context").

## 0.2.2

No changes in this release.

## 0.2.1

No changes in this release.

## 0.2.0

No changes in this release.

## 0.1.0

### Minor Changes

- [#48](https://github.com/lucasthevenet/arcadekit/pull/48) [`36fedda`](https://github.com/lucasthevenet/arcadekit/commit/36feddaaf0af8bc3218d7b8127b0b2f6505f54aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - First release.
