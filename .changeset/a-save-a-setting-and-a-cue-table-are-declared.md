---
"arcadekit": minor
---

A save is a declaration. `class MySave extends Save("MySave", { storageKey, field, record, mergeRecord }) {}` (`arcadekit/save`): the class is the key of its service, `layer` provides it over a `KeyValueStore`, and the service is a `Stored`, `read` and `write`. The stored format and the storage key are unchanged.

**Breaking**

- `arcadekit/save`: `makeSaveStore`, `SaveStore` and `mergeRecords` are gone. Declare a `Save`: its definition's `key` is `storageKey`; `load` is `read` and `merge(records)` is `write(records)`, which still merges into what is stored, both reached with `yield* MySave`; `mergeRecords(mergeRecord)` is the class's `MySave.merge`. `SaveDefinition` is generic over the record's Schema, and a `field` named `version` is refused.
- The log lines name the declaration: `Save "MySave" can't be read. ...`
