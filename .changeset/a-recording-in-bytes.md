---
"arcadekit": minor
---

Messages and recordings are written in bytes, with Effect's `SchemaBinary`, instead of JSON text. `Message.encode` returns a `Uint8Array` and `Message.decode` takes one. `Journal.encode` and `Journal.decode` do the same, and a recording holds its save as the bytes `Save.encode` writes, not in base64. `Message.Message` is now a schema, and the `Message`, `Issued` and `Made` types are what it holds, so the type and what is checked on the wire are one definition. A relay forwards the bytes a member sent, unchanged, once it has checked them. Measured on a two-peer game of 600 ticks, its messages take 55% fewer bytes, its recording 35% fewer, and one since a save 30% fewer.

What breaks:

- Messages and recordings written by an earlier version are not read: `Message.decode` and `Journal.decode` refuse text. A peer of an earlier version can't play with one of this version, and a relay of either refuses the other's messages.
- A message is a binary frame and a relay's notice is still a text frame. What carries them tells the two apart. A host that hands `Relay.forward` or `connection.receive` a message as a string is refused with `"not a message"`: pass binary frames as their bytes.
- `Relay.Delivery` has `data: string | Uint8Array` in place of `text`, and `Server.connect`'s `send` takes the same. Send `data` as it is, so a message goes out as a binary frame.
- `Relay.Options.maxLength` counts bytes, not characters.
- `Transport.text` is `Transport.fromWire`, and `Transport.TextTransport` is `Transport.WireTransport`. A `Wire` sends a message's bytes, `send(bytes: Uint8Array)`, and hands `listen` each frame as it came, a `Uint8Array` or a string.
