# `es-mini` — a real content pack, small enough to commit

What `packages/core/src/packs/loader.test.ts` loads, and what the P2 gate clause _"the
pack loads in `packages/core`'s pack loader tests"_ is satisfied against.

| File            | What it is                                                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed.json`     | the reviewable input: six Spanish sentences, nine lemmas, two units, seven exercises, three clips, five licence rows. Records are shaped exactly like the frozen inter-stage artefacts (`coursekit.artifacts`), so they are replayable as a real ledger. |
| `pack.sqlite`   | the read-only pack, **built by `coursekit`'s G9** from `seed.json`.                                                                                                                                                                                      |
| `manifest.json` | the manifest G9 wrote beside it. Unsigned: the ed25519 private key exists only as a CI secret.                                                                                                                                                           |
| `audio/*.opus`  | three content-addressed clips — see the warning below.                                                                                                                                                                                                   |

## The fixture is generated, not authored

```sh
cd tools/coursekit
uv run python -c "from coursekit.packbuild.sqlite import build_fixture_pack as b; print(b())"
```

Then review the diff like source. `tools/coursekit/tests/test_g9_package.py` rebuilds it
from `seed.json` on every run and compares **content** row by row, so a fixture that has
drifted from the builder is a red test rather than a surprise.

Content rather than bytes, deliberately: two SQLite builds of the same rows are not
byte-identical across library versions, and a byte comparison would turn a Homebrew
upgrade into a red test and teach everybody to regenerate the fixture without reading what
changed.

The reason the fixture is built by the real G9 rather than hand-written: a database
written to match the loader proves that the loader agrees with itself. This one proves
that the loader can open what the pipeline produces.

## `audio/*.opus` are **not audio**

They are short text stubs with an `.opus` extension. Nothing in the loader decodes audio —
it resolves a path, reports the declared codec and bitrate, and tells a caller which files
are missing (the S151 partial-pack fallback) — so a real Opus bake would add megabytes to
the repository to test nothing extra. The bytes on disk are the bytes the manifest
declares, which is the property `audio_bytes_on_disk` and INV-PACK-15 actually measure.

A real bake arrives with the Spanish pack at the end of P2 and does not live here.

## What this pack deliberately contains

- **Attribution that requires crediting.** Five Tatoeba sentences (CC BY 2.0 FR,
  attribution-only) and one machine-authored sentence under the pack's own CC BY-NC-SA
  4.0. Both need a credits row, which is INV-PACK-17's read half.
- **A derived list.** The hermitdave frequency data is CC BY-SA-4.0 and the ordering
  derived from it ships as the order units are taught in — neither a sentence nor a voice,
  and the kind of credit that gets forgotten.
- **An oracle-only corpus.** NLLB appears in the manifest's licence table with its OPUS
  _legacy page_ URL and never contributes a sentence.
- **Two shapes over one sentence.** `translate` and `listen` on `Hola, ¿cómo estás?` ask
  for different things, so they carry different item ids.
- **Empty `story`, `radio_episode` and `character_lesson` tables.** Present at v0 so P6 and
  P7 are not schema migrations on a file the app may not write to.
