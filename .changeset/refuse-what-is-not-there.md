---
"arcadekit": minor
"@arcadekit/three": minor
---

A state's handle and `Gltf.model` refuse, with a message that says what is wrong, what they used to pass on unchecked.

**Breaking**

- A state's handle throws on reading a value that is not one of the state's values, as a save from an older game can hold, where it returned that value. A migration renames a state's values in a save.
- `Gltf.model` fails with `Assets.AssetFailed` for a document whose `buffers`, `bufferViews` or `images` are not lists of what glTF has there, where it went on with them.
