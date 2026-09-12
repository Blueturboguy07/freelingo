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
| Parrot poses  |     6 | `art/mascot/` | S020, S067, S075             |
| Cast avatars  |     4 | `art/cast/`   | S034                         |
| Speech bubble |     1 | `art/cast/`   | S034                         |
| Node art      |    21 | `art/nodes/`  | S013–S019, S101              |
| Story covers  |     3 | `art/covers/` | S101                         |
| Sound cues    |    14 | `art/sound/`  | lesson player, ceremony, mic |

Poses: `idle`, `happy`, `sad`, `cheer`, `sleepy`, and `phoenix` (the S075 streak-milestone
form, drawn from the same silhouette in the milestone palette).

Node art covers seven kinds — `lesson`, `chest`, `story`, `trophy`, `speaking`, `letters`
and `jump` — in `locked`, `active` and `complete`. Two of those names are decisions rather
than labels:

- **`letters`, not `alphabet`.** `art/README.md`'s inventory line says "alphabet", but
  EC-PTH-42 / INV-PATH-24 name the pack-declarable node type `letters` and require it to
  have "its own glyph, locked/active/complete art". The node-type registry is _pack-driven_,
  so a Japanese pack declaring `letters` against a registry that only knows `alphabet`
  cannot be rendered from its own specs at all. The two names had to reconcile before P3
  wires this list to a `PathNode` variant, and the spec's name wins. The art is unchanged;
  the files were renamed.
- **`jump` is S019** (Node — Jump here), which this task owns and which had no art at all
  in the first pass. Two stacked chevrons pointing up the path, because the test moves the
  learner forward past the nodes above it. Its three authored states map onto S019's five:
  `active` is `offered`, `complete` is `passed`, and `locked` is the node before a test is
  offered on it. There is deliberately no `failed` art — S019 says failure is non-punitive
  and retryable, so a failed jump returns to `offered`.

The **progress ring** on an in-progress lesson node is deliberately not an asset: S014
shows sub-lessons within the node, so the ring is a number and the path component draws it
at P3. Baking a ring into the art would bake in a count.

Sound cues, one per row of `deep/08` §12 (the two-file rows are the word-bank variants and
the mic earcon): `correct`, `wrong`, `combo-shimmer`, `fanfare`, `chest`, `streak`,
`earcon-start`, `earcon-stop`, `tap`, `wordbank-place`, `wordbank-remove`, `xp-pip`,
`level-complete`, `quest-chime` — each shipped as `.opus` and `.m4a`.

Everything is registered in `packages/ui/src/assets/index.ts` with the product-map screens
that consume it, and a test fails if a registered asset is missing or names no screen.

## What is still missing against `art/README.md`

The README's v1 inventory is larger than this task's brief. Outstanding:

| Missing                                          | Named in           | Needed by |
| ------------------------------------------------ | ------------------ | --------- |
| Two tableau sprite kinds                         | S020               | P3        |
| 13 achievements × tiers, with no holes           | S125               | P4        |
| Cosmetics catalogue + one widget pose per outfit | S121, EC-ECO-13/36 | P4        |
| Nine widget states × three sizes                 | S-widget, WID-06   | P5        |
| Share-card composition                           | S088               | P4        |
| Phoenix _pose set_ (one pose exists, not a set)  | S075               | P4        |

Two entries in that table are corrections of claims this lane used to make:

- **S020 has one sprite kind, not two.** The mascot poses are the decorative sprite. The
  cast avatars used to be registered as S020 tableau sprites as well, which was a stand-in
  dressed as coverage; they now name S034 only, which is what they are.
- **S125 (achievements grid) has no art here.** `mascot/sleepy` used to claim it. The map
  row for S125 is a 13-award grid with named awards and no parrot in it, so the claim was
  simply wrong, and the `screens` test cannot catch a wrong id — it only checks the shape
  `S\d{3}`. The awards are P4 art and are listed above.

Nothing in `deep/08` §12's cue table is missing any more. The first pass shipped eight
cues against twelve rows and described the gap as "the three short ones", which was wrong
twice over: five rows were missing and two of them (`Level / node complete`, 1.2 s, and
`Quest/badge earned`, 700 ms) are long cues. All six files now exist, and
`test_the_bank_covers_every_spec_row` iterates the **spec** rather than the bank, so a
missing cue fails instead of going unnoticed by an inventory that only walks what exists.

## Regenerating

### The sound bank

```sh
uv sync --project tools/soundbank
uv run --project tools/soundbank python tools/soundbank/synthesize.py --out art/sound
```

This writes both encodes and `art/sound/manifest.json`. The WAV master is an intermediate
— it is what ffmpeg reads and what the reproducibility hash is taken over — and is deleted
once the encodes exist, so a bake leaves `git status` clean rather than fourteen untracked
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
| `node/jump/active`   |                    180 |    12 |       4 |     3 |
| `cast/pia`           |                    410 |    12 |       7 |     5 |
| `cast/speech-bubble` |                    192 |    12 |       3 |     2 |

The 17 px teal tail feather is the thinnest thing in `art/`. It is recorded here because
the floor has already caught it once: sleepy's tail measured **7 px** on the first render
and the fix was to splay the tail wider, not to lower the number.

The test carries its own falsifier — a frame whose only detail is a 2-unit stripe and a
5-unit dot, plainly there at 240 px and gone at 64 px. If that ever passes, the floor has
become decoration.

### The rasteriser

The floor renders SVG with `packages/ui/src/mascot/raster.ts`, 796 lines of arithmetic with
no dependencies, because the test has to run on a Linux CI box with nothing installed and
neither a system rasteriser nor a rendering library is this lane's to add. It supports a
deliberately small subset — solid fills, `path`/`circle`/`ellipse`/`rect`/`line`/
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

### EC-PLAT-09, actually asserted

`it('no .riv file is in the repository (EC-PLAT-09)')` walks the filesystem from the repo
root and fails on any hit, skipping only `node_modules` and `.git`. The version it replaced
iterated the art registry asserting every `source` ended in `.svg` — true by construction
of a list a person maintains by hand, and a refuter proved it: a real `art/rive/mascot.riv`
written into the worktree left the suite green.

The walk is used rather than `git ls-files '*.riv'` because an untracked Rive file in a
working tree is already the thing the ruling forbids and is one `git add -A` from being
committed. A second test plants a `.riv` under `art/build/`, requires the **same function**
to find it, and deletes it again — so a future rewrite back into a registry check goes red.

## The mascot seam and the cosmetic layer

`MascotRenderer` is `setNumber` + `fire` — number and trigger shaped, because Rive React
Native drives a rig through `useRiveNumber` / `useRiveTrigger`, so the swap EC-PLAT-09 defers
stays mechanical.

The number inputs are `pose`, **`outfit`**, `blink`, `bounce`. `outfit` is there because
EC-ECO-36 (→ INV-ECO-31) puts it there by name: an outfit is "a palette-and-accessory layer
on the parrot applied **inside `MascotRenderer`**, so every surface inherits it". That is a
statement about this interface. Without the input, the path, the ceremony and the widget
snapshot would each have to apply the cosmetic themselves and one of them would forget,
which is the bug the edge case is about.

What exists is the **seam, not the catalogue**: the gem-sink wardrobe and its one neutral
widget pose per outfit are P4 art (gaps table above). `MASCOT_OUTFITS` therefore holds only
`neutral`, and `outfitIndex()` resolves anything it does not know to it — which is
INV-ECO-31's own fallback rule ("a missing variant renders the neutral pose") and
EC-PLAT-10's "never an empty box", handled once here instead of at every call site. The
economy lane still owns INV-ECO-31 itself; `poses.test.ts` deliberately does not claim the
id, because an interface-shape test would report it as covered while the behaviour is
unwritten.

## The sound bank

`deep/08` §12 is explicit that its cue table is _a Freelingo specification, not a
transcription of Duolingo's bank_ — the assets were never captured and Duolingo publishes
no inventory. Every cue here is synthesised from numpy in
`tools/soundbank/synthesize.py`: marimba-ish partial stacks, inharmonic bell ratios,
band-passed noise, RBJ biquads. No samples, no libraries beyond numpy and soundfile.

The §12 table is transcribed into `SPEC_TABLE` and each `Cue` names the row it answers, so
the bank is pinned to the spec in both directions: a row with no cue fails, and a cue that
answers no row fails.

### Buses

Five, because per-class suppression (INV-SND-01) only means something if the classes are
the ones that can actually collide:

| Bus       | Cues                                                                | Level                |
| --------- | ------------------------------------------------------------------- | -------------------- |
| `sting`   | correct, wrong, fanfare, chest, streak, level-complete, quest-chime | −16 LKFS target      |
| `shimmer` | combo-shimmer                                                       | −6 dB (EC-COM-09)    |
| `earcon`  | earcon-start, earcon-stop                                           | sting level          |
| `ui`      | tap, wordbank-place, wordbank-remove                                | variants −3 dB (§12) |
| `pip`     | xp-pip                                                              | sting level          |

`pip` is separate from `sting` on purpose: §12 has the lesson-complete fanfare _duck under_
the XP ticks, so the two sound together by design, and sharing a class would let the rule
that protects the answer sting silence the ticks. `test_the_xp_pip_is_not_on_the_sting_bus`
holds that.

### The −6 dB shimmer (EC-COM-09 → INV-SND-01)

The edge case is the correct-answer sting and the combo-gold flip landing on the same
frame. §12's rule — "never two effects in the same frame, the later one wins" — would
silently drop either the primary feedback or the only audio marker of the combo threshold.
The ruling replaces it with per-_class_ suppression and layers the shimmer on a second bus
6 dB down. That is a number in the audio, so it is measured in the audio:
`test_shimmer_sits_exactly_six_db_under_the_sting_bus` reads the shipped cues' loudness out
of the manifest and asserts the difference is 6.00 ± 0.01, and separately asserts that the
sting bus is level across all seven sting cues. The word-bank variants' −3 dB is asserted
the same way against the tap.

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

Shipped: sting cues at −18.852 LKFS, the shimmer at −24.852 LKFS, the word-bank variants at
−21.852 LKFS, no cue above −1 dBFS. Adding six cues did not move that gain: `chest` is
still the peak that binds it (−1.000 dBFS), so the eight original cues re-baked **byte for
byte identical** — the manifest diff that added them is 78 insertions and no deletions.

### Reproducibility

`test_rebake_is_byte_identical` re-runs the entire synthesis into a temporary directory and
compares against the manifest, so "regenerate the bank" is never twenty-eight changed
binaries nobody can review.

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

One ordering rule matters when a cue is added: `render_bank_with_headroom` draws from a
single seeded generator in a fixed order, so **new cues go at the end**, or every
noise-bearing cue after the insertion point is rewritten. The six new cues were appended,
which is why the originals did not move.

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
- **A `screens` id is a claim a human has to check.** The test only matches `S\d{3}`, so a
  wrong id is unfalsifiable by machine. Two wrong ones were removed above; the rest were
  re-read against `00-PRODUCT-MAP.md` on 2026-09-11.
