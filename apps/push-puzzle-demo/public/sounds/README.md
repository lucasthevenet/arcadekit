# Sounds

Generated placeholders, made by `scripts/generate-placeholder-sounds.mjs` (run `pnpm sounds`). The script is deterministic, so running it again rewrites the same bytes.

Each file name, without `.wav`, is a sound id the app's cue-to-sound table refers to. Replace any file with a CC0 sound of the same name (for example from Kenney's audio packs) and the app picks it up with no code change. Running `pnpm sounds` again overwrites replaced files, so stop using the script once you have real sounds.
