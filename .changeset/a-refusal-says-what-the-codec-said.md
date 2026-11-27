---
"arcadekit": patch
---

A save, a capture or a snapshot that a `Field.ref` codec refuses says what the codec's `encode` threw, after the field's name: `"gr/Small.tiles" holds a value its codec refuses: a map of 3 by 3 is in a field of 2 by 2`. A `Field.schema` field says where its value fails the schema. Both used to say only that the codec "did not turn into plain data". Nothing breaks: only the text of the message of `Save.Refused` and of `SnapshotError` changes.
