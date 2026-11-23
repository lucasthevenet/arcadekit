---
"@arcadekit/three": minor
---

A Three.js loader that fetches files of its own can fetch them through `Assets.Loader`. `Three.manager(files)` fetches the files through `Assets.Loader` and returns a Three.js `LoadingManager` that serves them to any loader made with it, and refuses any other URL with an error that names it. `Gltf.model` takes the files its decoders fetch as `files`, and hands `prepare` the manager that serves them, so a test's in-memory files serve a compressed model's decoders, and leaving a level cancels their requests.

**Breaking**

- A DRACO or KTX2 loader set in `Gltf.model`'s `prepare` is made there, with the manager `prepare` receives, and its files are listed in `files`: `{ files: ["/draco/draco_decoder.wasm", "/draco/draco_wasm_wrapper.js"], prepare: (loader, manager) => loader.setDRACOLoader(new DRACOLoader(manager).setDecoderPath("/draco/")) }`. A decoder made without that manager fails the bundle with `Assets.AssetFailed`.
- The decoder is disposed of once the model is read, so one decoder is no longer shared between models.
