# @arcadekit/input

## 0.2.3

No changes in this release.

## 0.2.2

### Patch Changes

- [#60](https://github.com/lucasthevenet/arcadekit/pull/60) [`5558bd9`](https://github.com/lucasthevenet/arcadekit/commit/5558bd93cfc12f3e4ebbb76d33e224b6b6b6035e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `InputController` drags and swipes again on iPhone Safari. It has no pointer lock and leaves `document.pointerLockElement` undefined, which the check for a locked pointer read as locked, so every press was ignored.

## 0.2.1

### Patch Changes

- [#58](https://github.com/lucasthevenet/arcadekit/pull/58) [`9e2651a`](https://github.com/lucasthevenet/arcadekit/commit/9e2651a50ea9de9c41e0f94c96adcc826430d082) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `InputController` ignores pointer presses while the document has a pointer lock, such as a game's mouse look on the same surface. It used to call `setPointerCapture`, which throws `InvalidStateError` while the pointer is locked, so every click during mouse look threw from its listener. A locked pointer stays put on screen, so it can't drag or swipe anyway; drags and swipes work again once the lock is released.

## 0.2.0

No changes in this release.

## 0.1.0

### Minor Changes

- [#48](https://github.com/lucasthevenet/arcadekit/pull/48) [`36fedda`](https://github.com/lucasthevenet/arcadekit/commit/36feddaaf0af8bc3218d7b8127b0b2f6505f54aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - First release.
