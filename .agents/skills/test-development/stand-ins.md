# What stands in for the outside

What a game reaches outside itself, a test gives it by hand: files in memory, a source of input worked by hand, a display turned by hand, a bridge, an output that notes the sound it was asked for, a renderer that draws nothing. They are exports of the package, for a game's tests as much as for its own: `Test.make` makes an app with those of `arcadekit`, and [Testing a game](../../../website/src/content/docs/guides/testing.md) is their guide: read the section for what the test needs (devices, sound, files, a UI, what is drawn, a stand-in given by hand).

What only the package's own tests need beside it:

- **What only a page has is tested against stand-ins**, in `test/Browser.test.ts`: event targets that count their listeners, and `vi.stubGlobal` for `requestAnimationFrame`, the document and the window's `addEventListener`. Unstub them after each test.
- **What is drawn is compared with what Three.js makes.** Three.js makes its scenes and meshes under Node as in a page, so a test looks at what was put in the scene, and compares a matrix with the one Three.js itself makes of the same place.
- **A claim about allocation is measured**: the heap before and after a frame, many times, and the middle one.
- **The page's own sound output is tested against a stand-in for its audio**, given as `audio` and `decode`, as its devices are.
