# Art and sound

What exists, what does not, and the exact command that regenerates each artefact.

Everything in `art/` is original work made for this project. Nothing is derived from
Duolingo's assets, nothing is sampled, nothing is downloaded. Per EC-PLAT-09 there is no
`.riv` file in this repository and there will not be one until the Rive editor terms are
cleared; v1 uses code poses behind `MascotRenderer`.

The plan runs this lane in parallel from P1 and makes it a **P3 entry criterion**: mascot
poses, cast and sound bank exist before the lesson player is gated on them. It owns no
invariant ids — see `docs/owned/art.json` for why that is the right answer and not an
oversight.

## What exists

| Group         | Count | Where         | Consumers                    |
| ------------- | ----: | ------------- | ---------------------------- |
| Parrot poses  |     6 | `art/mascot/` | S020, S034, S067, S075, S125 |
| Cast avatars  |     4 | `art/cast/`   | S034, S020                   |
| Speech bubble |     1 | `art/cast/`   | S034                         |
| Node art      |    18 | `art/nodes/`  | S013–S019, S101              |
| Story covers  |     3 | `art/covers/` | S101                         |
| Sound cues    |     8 | `art/sound/`  | lesson player, ceremony, mic |

Poses: `idle`, `happy`, `sad`, `cheer`, `sleepy`, and `phoenix` (the S075 streak-milestone
form, drawn from the same silhouette in the streak palette).

Node art covers `lesson`, `chest`, `story`, `trophy`, `speaking` and `alphabet` in
`locked`, `active` and `complete`. The **progress ring** on an in-progress lesson node is
deliberately not an asset: S014 shows sub-lessons within the node, so the ring is a number
and the path component draws it at P3. Baking a ring into the art would bake in a count.

Sound cues: `correct`, `wrong`, `combo-shimmer`, `fanfare`, `chest`, `streak`,
`earcon-start`, `earcon-stop`, each shipped as `.opus` and `.m4a`.

Everything is registered in `packages/ui/src/assets/index.ts` with the product-map screens
that consume it, and a test fails if a registered asset is missing or names no screen.

## What is still missing against `art/README.md`

The README's v1 inventory is larger than this task's brief. Outstanding:

| Missing                                         | Named in         | Needed by |
| ----------------------------------------------- | ---------------- | --------- |
| Two tableau sprite kinds                        | S020             | P3        |
| 13 achievements × tiers, with no holes          | S125             | P4        |
| Cosmetics catalogue (the gem sink)              | S121, EC-ECO-13  | P4        |
| Nine widget states × three sizes                | S-widget, WID-06 | P5        |
| Share-card composition                          | S088             | P4        |
| Phoenix _pose set_ (one pose exists, not a set) | S075             | P4        |
| Tap / word-bank click cues, XP tick pip         | deep/08 §12      | P3        |

The cast avatars double as S020 tableau sprites for now, which covers the screen but is
not the "two sprite kinds" the map asks for.

The three sound cues not yet synthesised are the short ones (`tap` at 60 ms, the two
word-bank variants at −3 dB, the 40 ms XP pip). They are cheap to add to
`tools/soundbank/synthesize.py` — but note the ordering rule in `render_bank_with_headroom`:
the seeded generator is drawn from in a fixed order, so **new cues go at the end**, or
every noise-bearing cue after the insertion point is rewritten.

## Regenerating

### The sound bank

```sh
uv sync --project tools/soundbank
uv run --project tools/soundbank python tools/soundbank/synthesize.py --out art/sound
```

This writes both encodes and `art/sound/manifest.json`. The WAV master is an intermediate
— it is what ffmpeg reads and what the reproducibility hash is taken over — and is deleted
once the encodes exist, so a bake leaves `git status` clean rather than eight untracked
files the repository has decided not to carry. The manifest keeps each master's SHA-256, so
a change in the audio is still a reviewable diff. Pass `--keep-wav` to listen to one.

```sh
uv run --project tools/soundbank pytest tools/soundbank
```

Note the path argument. Without it pytest takes the repository root as its rootdir, does
not read `tools/soundbank/pyproject.toml`, and tries to collect `tools/coursekit`'s tests
against soundbank's virtualenv — which fails on `typer`. (`tools/soundbank/README.md`
documents the invocation without the path; that file is outside this task's lane.)

### The rasterised previews

```sh
FREELINGO_ART_PREVIEW=1 pnpm vitest run --project ui
```

Every asset is rendered to `art/build/<group>/<name>@64.png` and `@240.png`. These are not
committed — the repository `.gitignore` ignores any directory called `build/`, which is the
right outcome: a committed PNG of a pose is a second source of truth that drifts the moment
somebody edits one and not the other. The floor that protects the art is the test, which
re-renders from the SVG on every run; the PNGs exist so a human can see what the numbers
are describing.

## The 64 px floor

deep/08 §10: _"Every illustration must be readable at 64 px (widget) and 240 px (ceremony)
from the same source."_ That failure is invisible to whoever causes it — art is authored,
reviewed and approved at desk size, and the widget renders it at 64 px. So it is a test:
`packages/ui/src/mascot/legibility.test.ts` re-renders every committed asset at both sizes
and asserts four things.

1. **Colour survival.** Every colour the source paints must occupy ≥ 12 near-pure pixels at
   64 px. This is the mush detector: a feature authored too small does not vanish from the
   240 px render, it vanishes from the 64 px one, and this is where that shows up.
2. **Ink coverage** within a per-class band.
3. **Coverage drift** between 64 px and 240 px ≤ 0.05 — the whole drawing thickening or
   thinning as detail merges, which the census can miss.
4. **Region count** at 64 px, per class.

Floors are **per asset class**, because a class is what decides how much information the
asset is supposed to carry. The first draft used one pair of numbers for everything and
failed thirteen assets: a lesson node is _meant_ to be three flat blocks and a story cover
is _meant_ to be a full-bleed card, and holding them to a figure's spec was the test being
wrong, not the art.

| Class    | Ink at 64 px | Regions | What it is made of                              |
| -------- | ------------ | ------: | ----------------------------------------------- |
| `mascot` | 0.20 – 0.85  |       8 | body, belly, two wings, crest, eyes, beak       |
| `cast`   | 0.20 – 0.95  |       5 | plate, garment, face, hair, eyes, mouth         |
| `node`   | 0.30 – 0.95  |       3 | lip, face, icon                                 |
| `cover`  | 0.95 – 1.00  |       3 | card, band, motif (full-bleed by design)        |
| `frame`  | 0.50 – 0.98  |       2 | outer box + inner face (the `scope/10` pattern) |

Measured 2026-09-11, tightest margins:

| Asset                | Rarest colour at 64 px | Floor | Regions | Floor |
| -------------------- | ---------------------: | ----: | ------: | ----: |
| `mascot/sad`         |                     17 |    12 |      27 |     8 |
| `mascot/cheer`       |                     17 |    12 |      20 |     8 |
| `mascot/sleepy`      |                     17 |    12 |      17 |     8 |
| `node/lesson/active` |                    180 |    12 |       3 |     3 |
| `cast/pia`           |                    410 |    12 |       7 |     5 |
| `cast/speech-bubble` |                    192 |    12 |       3 |     2 |

The 17 px teal tail feather is the thinnest thing in `art/`. It is recorded here because
the floor has already caught it once: sleepy's tail measured **7 px** on the first render
and the fix was to splay the tail wider, not to lower the number.

The test carries its own falsifier — a frame whose only detail is a 2-unit stripe and a
5-unit dot, plainly there at 240 px and gone at 64 px. If that ever passes, the floor has
become decoration.

### The rasteriser

The floor renders SVG with `packages/ui/src/mascot/raster.ts`, ~450 lines of arithmetic
with no dependencies, because the test has to run on a Linux CI box with nothing installed
and neither a system rasteriser nor a rendering library is this lane's to add. It supports
a deliberately small subset — solid fills, `path`/`circle`/`ellipse`/`rect`/`line`/
`polygon`/`polyline`, `translate`/`rotate`/`scale`/`matrix`, round-capped strokes — and
**throws on anything outside it**, including elliptical arcs and gradient fills. A silently
dropped element would be a silently wrong measurement.

`raster.test.ts` checks it against shapes whose coverage is known in closed form (a disc is
πr²) rather than against a baseline image, which would only prove it still does whatever it
did last time.

It found one bug that no metric would have: a polyline's segment quads were wound in
opposite directions around a corner, so non-zero winding cancelled their overlap and
punched a hole through the joint. The completed-node badge rendered as a broken scribble
instead of a tick. Only looking at the PNG caught it; `strokeRings` now forces one winding
and a test pins it.

## The sound bank

`deep/08` §12 is explicit that its cue table is _a Freelingo specification, not a
transcription of Duolingo's bank_ — the assets were never captured and Duolingo publishes
no inventory. Every cue here is synthesised from numpy in
`tools/soundbank/synthesize.py`: marimba-ish partial stacks, inharmonic bell ratios,
band-passed noise, RBJ biquads. No samples, no libraries beyond numpy and soundfile.

### The −6 dB shimmer (EC-COM-09 → INV-SND-01)

The edge case is the correct-answer sting and the combo-gold flip landing on the same
frame. §12's rule — "never two effects in the same frame, the later one wins" — would
silently drop either the primary feedback or the only audio marker of the combo threshold.
The ruling replaces it with per-_class_ suppression and layers the shimmer on a second bus
6 dB down. That is a number in the audio, so it is measured in the audio:
`test_shimmer_sits_exactly_six_db_under_the_sting_bus` reads the shipped cues' loudness out
of the manifest and asserts the difference is 6.00 ± 0.01, and separately asserts that the
sting bus is level across all six sting cues.

### Loudness, and one honest deviation

§12 asks for −16 LUFS. Two things had to be reconciled:

- **BS.1770 cannot measure these cues.** The gated algorithm averages 400 ms blocks; the
  correct sting is 240 ms and the mic earcon is 120 ms, so there are zero complete blocks.
  `cue_loudness_lkfs` therefore applies BS.1770-4's K-weighting and its
  `−0.691 + 10·log₁₀(mean square)` law over the whole cue with no gating. The implementation
  is checked against the standard's published calibration point: a full-scale 997 Hz sine
  reads **−3.0103 LKFS** against the specified −3.01.
- **−16 LKFS clips these cues.** Percussive one-shots have a 10–18 dB crest factor. On the
  first bake, the correct sting normalised to −16 LKFS peaked at **+1.85 dBFS**, and the
  script refused to write it rather than limiting it quietly.

Limiting each cue individually would have fixed the peaks and destroyed the thing that
matters — each cue would move by a different amount and the 6 dB bus relation would be
gone. So **one gain is applied to the whole bank**: `bankHeadroomGainDb = −2.852`. Every
bus relation is exact to the last decimal; absolute loudness is 2.852 dB under the −16
target, and both the gain and each cue's resulting loudness are recorded in
`art/sound/manifest.json` so the deviation is on the record rather than a surprise.

Shipped: sting cues at −18.852 LKFS, the shimmer at −24.852 LKFS, no cue above −1 dBFS.

### Reproducibility

`test_rebake_is_byte_identical` re-runs the entire synthesis into a temporary directory and
compares against the manifest, so "regenerate the bank" is never eight changed binaries
nobody can review.

The WAV hashes are asserted **unconditionally** — pure numpy, so a change is a change in
the audio. The Opus and AAC hashes are asserted **only when the local ffmpeg's version
string matches the one recorded in the manifest**, because a codec's bitstream is a
property of that codec build (libopus writes its own version into the OpusTags packet) and
demanding byte-equality across ffmpeg builds would assert something this script does not
control.

Two muxer settings are what make the encodes reproducible at all, and
`test_encoding_is_not_timestamped` exists to say so: `-fflags +bitexact` (the mp4 muxer
otherwise stamps `creation_time`) and `-serial_offset 0` (the Ogg muxer otherwise
randomises the page serial). Either one alone turns every rebake into a full-bank diff.

Baked 2026-09-11 with ffmpeg 8.1.2, numpy 2.5.3, Python 3.12, seed `20260911`.

## Known gaps in this lane

- **`tools/soundbank`'s tests are in no workflow.** `ci.yml` runs lint, typecheck,
  `pnpm test`, the registry digest, coverage map and gitleaks; `pack-ci.yml` runs
  `coursekit validate` on content changes. Nothing runs `pytest tools/soundbank`, so the
  reproducibility gate is currently a local one. `.github/workflows/` is outside this
  task's lane.
- **`@freelingo/ui` does not export the registry.** `packages/ui/src/index.ts` and
  `package.json`'s `exports` map are outside this lane, so `ART_INDEX`, `MASCOT_POSES` and
  `MascotRenderer` are reachable only by deep path. P3 needs an `./assets` and `./mascot`
  export entry.
- **Cross-architecture WAV hashes are unproven.** The bank was baked on arm64 macOS. numpy
  uses its own vectorised transcendental kernels, so a different architecture could in
  principle move a sample by one LSB before int16 quantisation. If that happens the test
  will say so loudly rather than silently — which is the correct failure — but it has not
  been run on x86 Linux.
- **The node art is the plate, not the node.** Rings, the START bubble, the bounce and the
  unlock spring are components (deep/08 §11), and belong to P3.
