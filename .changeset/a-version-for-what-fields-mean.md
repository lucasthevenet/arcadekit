---
"arcadekit": patch
---

The doc comments of `App.Options.version` and `Save.Save.version` say what a load checks whatever the version: each component's storage and its fields' names, order and kinds, refused with `"component changed"`. They say what it can't check, a field whose values mean something else with the same shape, which loads with no error unless the version is incremented and a migration converts the values. Nothing breaks.
