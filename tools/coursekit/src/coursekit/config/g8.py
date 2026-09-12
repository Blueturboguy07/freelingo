"""Constants owned by bake (G8).

The voice cast per language, engine selection, loudness target and tolerance, the
transcode settings, and the per-pipeline byte reservations INV-PACK-15 asserts against.

Three findings from the adversarial review of `deep/10` §S8 are encoded here rather
than described somewhere:

- **R13** — the inherited "35-40 MB bank per language" is arithmetically impossible:
  8,000 utterances inside 40 MB is 4.4 KB each, about 14 kbps for a 2.5 s clip, which
  no codec delivers intelligibly. The plan re-declared the budget at
  `AUDIO_BUDGET_MB = 120` (in `config/base.py`, shared) and named a codec and a
  bitrate. `OPUS_BITRATE_KBPS` and `BYTES_PER_SECOND_AT_BITRATE` below are what make
  that budget checkable instead of quotable.
- **R14** — the cost and size model counted *lessons only*, while Stories and Radio
  ride the same cast, the same validators and the same budget. So the budget is split
  three ways here, and the two pipelines that do not exist yet carry a **named, sized
  reservation** rather than an implicit zero. A zero would let the lesson bank grow
  into space Stories and Radio have already been promised, and the overrun would be
  discovered at P6.
- **R15** — the cast mixes accents inside one course and never says so. Its Polly
  version was forced by the roster; the Kokoro version is worse: Kokoro publishes no
  locale sub-tag for its Spanish voices at all, so nothing in this toolchain can
  falsify a regional claim. **Founder ruling B6, 2026-09-12, settles what the files
  say about it**: a cast and a manifest carry `language` plus `accent_claim`, and the
  `locale:` key is gone. `ACCENT_CLAIMS` below is the whole permitted vocabulary and it
  has one member.

Owner: p2-g8-bake
"""

from __future__ import annotations

from typing import Final

from .base import AUDIO_BUDGET_MB, OPUS_BITRATE_KBPS

# ---------------------------------------------------------------------------
# The cast
# ---------------------------------------------------------------------------

#: The four cast roles, in the order they appear on a pack detail screen (S002).
#: `narrator` is the parrot: the mascot's voice and the default drill voice, the one a
#: listening exercise (S038) plays when no character is speaking.
CAST_ROLES: Final[tuple[str, ...]] = ("narrator", "adult_male", "adult_female", "young")

#: Every accent claim a cast or a manifest may make. Exactly one, and that is the point.
#:
#: Founder ruling B6: "Manifests replace `locale: es-ES` with `language: es` +
#: `accent_claim: unverified`; the reviewer rubric checks accent consistency". Azure
#: Neural published a locale sub-tag per voice, so `es-ES` was vendor-backed and
#: machine-checkable; Kokoro publishes none and its Spanish G2P is generic espeak-ng
#: `es`, so after the vendor swap NOTHING in this toolchain could contradict the string.
#: A claim with no possible falsifier is not a claim, so the string is gone and what is
#: left says how much is known.
#:
#: There is no `verified` member yet ON PURPOSE. The only thing that can produce one is
#: the 300-item native-reviewer sample (B3), and its accent question has not been
#: answered by anyone; a second member would exist so that somebody could write it in a
#: YAML file. When the sample comes back, the member and the evidence arrive together.
ACCENT_CLAIMS: Final[tuple[str, ...]] = ("unverified",)

#: What a file that declares nothing is taken to claim. The weakest member, which is
#: what makes the default safe: an absent declaration can never read as a stronger claim
#: than a present one.
DEFAULT_ACCENT_CLAIM: Final[str] = "unverified"

#: Keys a cast file may not carry, and the ruling that removed each one. `load_cast`
#: refuses the FILE rather than ignoring the key: a `locale:` still sitting in a cast
#: that the loader has stopped reading is a course claim nothing enforces, which is
#: exactly the state B6 exists to end.
CAST_FORBIDDEN_KEYS: Final[dict[str, str]] = {
    "locale": (
        "founder ruling B6 (2026-09-12) replaced `locale:` with `language:` + "
        "`accent_claim:`. Kokoro publishes no locale sub-tag for its Spanish voices and "
        "its Spanish G2P is generic espeak-ng, so a regional tag here was a claim no "
        "part of this toolchain could falsify — only the 300-item native-reviewer "
        "sample can, and it checks accent consistency rather than a tag. Delete the key "
        "and declare `accent_claim: unverified`; LOCALE_BY_LANGUAGE survives in "
        "`config/base.py` for URL templates (packbuild/attribution.py) and nowhere else."
    ),
}

#: Which synthesis engine bakes which language.
#:
#: There are no cloud keys in this environment and there is no runtime TTS (D3), so
#: this is the open-weights path the plan names, not a fallback. Kokoro is Apache-2.0
#: code AND weights and covers `e` (es), `f` (fr) and `j` (ja); it has no German, so de
#: is Piper's at P7 — a GPL-3.0 BUILD-TIME TOOL whose synthesiser never links into the
#: app. Piper's single Japanese voice is deliberately unreachable: review R7 found
#: `ja/ja_JA/hi_fi_captain/medium` carries a MODEL_CARD stating CC BY-NC-SA 4.0, the
#: identical NC conflict that cut TED2020 from the corpora.
BAKE_ENGINE_BY_LANGUAGE: Final[dict[str, str]] = {
    "es": "kokoro",
    "fr": "kokoro",
    "de": "piper",
    "ja": "kokoro",
}

#: Kokoro's `lang_code`, which is NOT the language code the rest of the pipeline uses.
KOKORO_LANG_CODE: Final[dict[str, str]] = {"es": "e", "fr": "f", "ja": "j"}

#: The espeak-ng tag Kokoro's G2P path phonemises with. misaki first-classes only en,
#: ja, ko, zh and vi, so Spanish and French fall to a generic espeak path — which is
#: the technical reason the cast file cannot claim a Peninsular accent from the vendor.
KOKORO_ESPEAK_LANG: Final[dict[str, str]] = {"es": "es", "fr": "fr-fr", "ja": "ja"}

#: Kokoro v1.0's model and voice-pack files, and where the bake looks for them.
#: Pinned by release tag, never `latest`: a voice-pack change moves every style vector
#: and silently re-renders a bank whose clip ids did not change.
KOKORO_RELEASE_TAG: Final[str] = "model-files-v1.0"
KOKORO_MODEL_FILENAME: Final[str] = "kokoro-v1.0.onnx"
KOKORO_VOICES_FILENAME: Final[str] = "voices-v1.0.bin"
KOKORO_RELEASE_URL: Final[str] = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/{tag}/{filename}"
)
#: Overridable so CI and a developer box can share one cache without a symlink.
KOKORO_WEIGHTS_ENV_VAR: Final[str] = "COURSEKIT_KOKORO_WEIGHTS"
KOKORO_WEIGHTS_DEFAULT_DIR: Final[str] = "~/.cache/freelingo/kokoro"

#: sha256 of the two pinned weight files, measured 2026-09-12 on the release above.
#: A weights swap that keeps the filename is otherwise invisible, and it changes every
#: clip in the bank while leaving every clip id alone.
#:
#: This gate earned itself on its first run. The first `coursekit bake es` was started
#: against a download that had not finished — 44 MB of a 325 MB model, with the right
#: name in the right place — and it stopped there instead of loading a truncated ONNX
#: graph and baking whatever came out.
KOKORO_WEIGHTS_SHA256: Final[dict[str, str]] = {
    "kokoro-v1.0.onnx": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}

#: Byte sizes of the pinned files, so a half-downloaded model is named as such before
#: the 325 MB digest is computed over it.
KOKORO_WEIGHTS_BYTES: Final[dict[str, int]] = {
    "kokoro-v1.0.onnx": 325_532_387,
    "voices-v1.0.bin": 28_214_398,
}

#: Kokoro's synthesis sample rate. opusenc resamples to 48 kHz internally.
KOKORO_SAMPLE_RATE: Final[int] = 24_000

#: Kokoro v1.0 ships exactly THREE Spanish style vectors. Measured, not read: loading
#: `voices-v1.0.bin` and filtering the 54 keys on the `e` prefix gives
#: `ef_dora`, `em_alex`, `em_santa` and nothing else. A four-role cast therefore cannot
#: be four stock voices, which is why `content/es/cast.yaml` declares one role as a
#: deterministic blend and says so. `tests/test_cast.py` asserts this list against the
#: real voice pack when the `tts` group is installed, so the day Kokoro ships a fourth
#: Spanish voice the cast decision is re-opened by a failing test rather than by luck.
KOKORO_SPANISH_VOICES: Final[tuple[str, ...]] = ("ef_dora", "em_alex", "em_santa")

#: Piper's German voice tree. R15's German row (`de-AT Hannah` beside three de-DE
#: voices) is the same accent-mix problem in another vendor; P7 owns the decision.
PIPER_VOICE_URL: Final[str] = (
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/{voice}/{quality}/"
)
#: The language Piper may bake. Not a preference: see R7 above.
PIPER_LANGUAGES: Final[tuple[str, ...]] = ("de",)

# ---------------------------------------------------------------------------
# What gets a clip (V7)
# ---------------------------------------------------------------------------

#: Where each AUDIO-BEARING shape's spoken string comes from. Keyed by SHAPE.
#:
#: It was keyed by coarse type (`TARGET_TEXT_FIELD_BY_TYPE`, `"listen":
#: "accepted_answers"`, `"speak": "prompt"`, …) and a coarse type is up to four shapes
#: that do not speak the same string. Three consequences, all measured on the real
#: Spanish course on 2026-09-12 when G9 first saw G7's and G8's output in one tree:
#:
#: * `listen_for_the_missing_word` accepts ONE TOKEN (the missing word) and its clip is
#:   the WHOLE SENTENCE — S038 is "audio plus a sentence with one gap" (`deep/01` §S038).
#:   Reading `accepted_answers[0]` baked the answer instead of the sentence, so the clip
#:   G7 named was never baked and G9 refused the pack with `FOREIGN KEY constraint
#:   failed`.
#: * `speak` and `translate` mapped to `prompt`, which is `instruction\nbody` — so the
#:   bank held clips whose first words are "Speak this sentence".
#: * `translate` and `word_bank` have NO audio-bearing shape at all (`needs_audio` is
#:   false for every one of them), so every clip baked for them was a clip no exercise
#:   plays: bytes inside the 120 MB budget doing nothing, and a V7 finding each.
#:
#: So the key is the shape, the source is named per shape, and the SET OF KEYS is
#: asserted against `{shape for shape in SHAPES if shape.needs_audio}` — a shape that
#: declares audio and is missing here is a KeyError at plan time, not a silent skip.
#: `match` is absent for the reason it used to be `None`: the grid's audio is per tile,
#: is generated from the tiles' own lexemes at P6, and pretending a pair has one spoken
#: string would give V7 a clip nothing plays.
SPOKEN_TEXT_SOURCE: Final[dict[str, str]] = {
    # The learner produces the sentence; the clip is the sentence, and plays on the
    # correct-answer reveal and in the mistake queue.
    "tap_what_you_hear": "accepted_answer",
    "type_what_you_hear": "accepted_answer",
    # An open response (`[DEPART D-SKIPSPEAK]`): the clip is the prompt line itself.
    "listen_and_respond": "accepted_answer",
    # S037's spoken reply line.
    "complete_the_chat": "accepted_answer",
    # The sentence under the instruction, which is what the learner is asked to read.
    "speak_this_sentence": "body",
    # The sentence the learner hears, reassembled from the rendered body and the token
    # that fills its blank. The body keeps the original punctuation (`_gapped` cuts the
    # span out of the sentence), so the reassembly is the sentence byte for byte — which
    # is what makes G7's clip id and G8's agree.
    "listen_for_the_missing_word": "body_with_the_gap_filled",
}

#: The role every LESSON clip is spoken by today.
#:
#: One role, not four, and that is a statement about the exercise record rather than
#: about the cast: an `exercise` carries no speaker field, so nothing in a lesson can
#: assign a character. The other three roles are cast for Stories and Radio at P6 —
#: and for the pack-detail sample below, which is what keeps them from being three
#: declarations nobody has ever heard.
LESSON_ROLE: Final[str] = "narrator"

#: One sample line per role, baked into every pack and played by S002's
#: `sample-playing` state ("sample sentence + speaker"). This is the reason all four
#: cast voices are in the shipped bank even before Stories exist, and the reason V7's
#: second half ("every audio file has a string") holds for them: the string is here.
CAST_SAMPLE_TEXT: Final[dict[str, str]] = {
    "narrator": "Hola, soy el loro. Vamos a aprender español juntos.",
    "adult_male": "Buenos días. ¿Cómo está usted hoy?",
    "adult_female": "Me llamo Rosa y vivo cerca del parque.",
    "young": "¡Mira, mamá! El pájaro verde está en la ventana.",
}

# ---------------------------------------------------------------------------
# Loudness (INV-AUD-08)
# ---------------------------------------------------------------------------

#: The loudness every packed clip is normalised to, in LUFS.
#:
#: -16 is not an arbitrary broadcast number: it is what `deep/08` §12 specifies for the
#: SOUND BANK, and EC-PACK-52 is precisely the failure of a voice bank averaging
#: -19.6 LUFS playing into a sting mastered somewhere else. One target for both banks
#: is the only way a correct-answer sting and the line before it sit at the same level.
TARGET_LUFS: Final[float] = -16.0

#: How far a packed clip may sit from the target, in LU, before the bake refuses it.
#:
#: The number is declared and then MEASURED (INV-AUD-08 says "measures within a declared
#: tolerance", not "is normalised and therefore assumed"). 0.5 LU is tight enough that a
#: clip which drifted cannot hide and loose enough to survive the lossy round trip: the
#: measurement that matters is taken on the DECODED Opus file, not on the PCM that went
#: into the encoder, because a 20 kbps encode is where a clip actually changes.
LOUDNESS_TOLERANCE_LU: Final[float] = 0.5

#: A clip shorter than one BS.1770 block (400 ms) has no complete gating block, so the
#: gated algorithm returns nothing for it. Below this length the meter falls back to the
#: ungated whole-signal reading and the manifest records which was used.
LOUDNESS_BLOCK_MS: Final[int] = 400
LOUDNESS_BLOCK_OVERLAP: Final[float] = 0.75
#: BS.1770-4's two gates.
LOUDNESS_ABSOLUTE_GATE_LUFS: Final[float] = -70.0
LOUDNESS_RELATIVE_GATE_LU: Final[float] = -10.0

#: Sane bounds for one spoken line, in milliseconds (V7's third clause).
#:
#: These are wide on purpose. They are not a quality metric; they catch the failure
#: nothing else in the pipeline can see — a phonemiser handed the wrong language, or an
#: empty phoneme string, which leaves the text, the licence and the loudness all
#: perfectly valid and the audio unusable. 250 ms is below the shortest plausible A1
#: utterance ("Sí.") and 30 s is above the longest story beat.
MIN_CLIP_MS: Final[int] = 250
MAX_CLIP_MS: Final[int] = 30_000

#: True peak is not measured here (that needs 4x oversampling); sample peak is, and a
#: normalised clip that clips the encoder is a real defect at -16 LUFS on speech.
PEAK_CEILING_DBFS: Final[float] = -1.0

#: The limiter, and why the chain has one at all.
#:
#: MEASURED on the first real bake: Kokoro's Spanish output has a crest factor of
#: 16-21 dB (three clips: 16.6, 20.9, 16.0). Scaled to -16 LUFS that puts peaks between
#: 0 and +5 dBFS, so a bake that only normalises and then obeys a -1 dBFS ceiling ships
#: every clip 5-6 LU under target — which is exactly EC-PACK-52's -19.6 LUFS voice
#: bank, arrived at by a different route. The first run of this stage did precisely
#: that and its own gate caught it: "23 clip(s) outside the declared loudness
#: tolerance".
#:
#: Two specs cannot both hold by scaling alone, so the chain gains the stage every
#: broadcast chain has: a look-ahead peak limiter, applied before the final
#: normalisation, whose gain reduction is RECORDED PER CLIP in the manifest. The
#: alternative — relaxing the target to whatever the peaks allow — is the failure this
#: invariant exists to prevent.
LIMITER_LOOKAHEAD_MS: Final[float] = 4.0
LIMITER_SMOOTH_MS: Final[float] = 2.0
#: Limiting lowers loudness, so the target is approached iteratively: limit, measure,
#: make up, limit again. Six passes is far more than the two or three it takes; the
#: loop exits on convergence and a clip that never converges is a failed bake, not a
#: quietly mislevelled one.
MASTER_MAX_PASSES: Final[int] = 6

#: How many times the bake may re-encode one clip to land it inside the tolerance.
#:
#: Also measured, on the second real bake: with the limiter in the chain the PCM
#: converges to within 0.25 LU of target, and the 20 kbps Opus encode then costs a
#: further 0.37-0.75 LU — systematically, on every clip. Seventeen of twenty-three
#: clips failed the gate by between 0.5 and 0.75 LU.
#:
#: The choice there is the whole invariant in miniature. Widening the tolerance to
#: cover the encode loss would make INV-AUD-08 true by declaration: the bank would sit
#: half a LU under the sound bank and the gate would say it was fine. So the bake
#: closes the loop on the SHIPPED file instead — encode, decode, measure, correct the
#: PCM gain by the error, encode again. Two passes is what it takes in practice.
ENCODE_MAX_PASSES: Final[int] = 4

# ---------------------------------------------------------------------------
# Transcode
# ---------------------------------------------------------------------------

#: The encoder. `opusenc` from opus-tools, not ffmpeg: it is the reference CLI, it
#: writes OggOpus with the right channel mapping, and its `--bitrate` is in kbps of the
#: whole stream, which is the number the budget is written in.
OPUS_ENCODER: Final[str] = "opusenc"

#: Encoder arguments, as a template. `{bitrate}` is `OPUS_BITRATE_KBPS`.
#:
#: `--speech` picks the SILK/hybrid path Opus was designed for at this bitrate;
#: `--framesize 20` is the speech default and keeps per-frame overhead low;
#: `--comp 10` is the slowest, smallest setting, which is free at build time;
#: `--downmix-mono` because every voice line is mono and a stereo stream at 20 kbps
#: spends half its bits on silence.
#:
#: `--serial` is the one that is not a quality setting. Without it opusenc picks a
#: RANDOM Ogg stream serial per invocation, so two encodes of identical PCM produce
#: different bytes and a different sha256. Measured on this machine: a re-bake of the
#: unchanged Spanish bank moved all 23 committed digests while every `bytes`,
#: `duration_ms` and `loudness_lufs` stayed identical to the last decimal. The manifest
#: claims to be "everything needed to say whether a rebuild produced the same bank",
#: and without a fixed serial that claim was false — a reproducibility check would have
#: reported 23 changed clips on a no-op rebuild, every time, and the signal would have
#: been useless exactly when a real drift appeared.
OPUS_ENCODER_ARGS: Final[tuple[str, ...]] = (
    "--quiet",
    "--speech",
    "--bitrate",
    "{bitrate}",
    "--framesize",
    "20",
    "--comp",
    "10",
    "--downmix-mono",
    "--discard-comments",
    "--discard-pictures",
    "--serial",
    "{serial}",
)

#: The Ogg stream serial is derived from the clip id rather than fixed at a constant:
#: each clip is its own physical stream, so any value is legal, but a per-clip serial
#: keeps the streams distinguishable if a bank is ever chained or concatenated. The
#: mask keeps it inside a positive 32-bit integer, which is what `--serial` parses.
OPUS_SERIAL_MASK: Final[int] = 0x7FFFFFFF

#: The decoder used to MEASURE what was shipped. Measuring the encoder's input would
#: prove nothing about the file in the pack.
#: Two flags that are not decoration, both measured against opus-tools 0.2:
#:
#: - `--force-wav`, because `opusdec file.opus -` writes RAW PCM to stdout with no
#:   header ("file does not start with RIFF id"). The header carries the rate and the
#:   sample format, and inferring those rather than reading them is how a measurement
#:   ends up off by a resample.
#: - `--no-dither` and NOT `--float`, because `--float --force-wav` emits
#:   WAVE_FORMAT_EXTENSIBLE with an IEEE-float subformat that the Python stdlib's
#:   `wave` refuses outright ("unknown extended format: 00000003-..."). 16-bit is
#:   ample for a loudness reading — quantisation noise sits near -96 dBFS against a
#:   -16 LUFS target — and `--no-dither` keeps two decodes of one file identical, so a
#:   re-measurement is not noise on the last decimal.
OPUS_DECODER: Final[str] = "opusdec"
OPUS_DECODER_ARGS: Final[tuple[str, ...]] = ("--quiet", "--no-dither", "--force-wav")

#: Clip filenames: `<clip_id>.opus`, where `clip_id` is the 16-hex re-bake key. A
#: single edited line changes exactly one id and therefore re-renders exactly one file.
CLIP_FILENAME: Final[str] = "{clip_id}.opus"

#: Where a language's bank lands under the run directory. The bank itself is
#: gitignored; only `content/<lang>/audio-manifest.json` is committed.
BANK_DIRNAME: Final[str] = "bank"

#: The committed manifest: hashes, durations, byte counts, voice, engine. Never bytes.
AUDIO_MANIFEST_FILENAME: Final[str] = "audio-manifest.json"
CAST_FILENAME: Final[str] = "cast.yaml"
CONTENT_DIRNAME: Final[str] = "content"

#: Override for `content/`, so a test can hand the loader a fixture tree without
#: writing into the repository's own committed cast file.
CONTENT_ROOT_ENV_VAR: Final[str] = "COURSEKIT_CONTENT_ROOT"

#: The manifest's own schema version, separate from the artefact contract's: the
#: manifest is a SHIPPED file the app reads, and the app's copy cannot be re-run.
AUDIO_MANIFEST_VERSION: Final[int] = 1

# ---------------------------------------------------------------------------
# The budget, split three ways (INV-PACK-15, R14)
# ---------------------------------------------------------------------------

#: Decimal MB, the unit S002 and S133 render ("38 MB audio"). Both mobile OSes report
#: file sizes in decimal, so the learner-visible number and the gate agree.
BYTES_PER_MB: Final[int] = 1_000_000

#: Bytes one second of audio costs at the declared bitrate. This single line is what
#: R13 found missing: with it, every size claim in the plan is checkable arithmetic.
BYTES_PER_SECOND_AT_BITRATE: Final[float] = OPUS_BITRATE_KBPS * 1000 / 8

#: The lesson denominator R13 argued against, kept as-is so the arithmetic is
#: comparable: ~8,000 utterances averaging 2.5 s.
LESSON_UTTERANCE_TARGET: Final[int] = 8_000
LESSON_SECONDS_PER_UTTERANCE: Final[float] = 2.5

#: Stories and Radio do not exist until P6. Their reservation is explicit and sized so
#: the lesson bank cannot quietly eat it. Sixty three-minute stories and twenty
#: seven-minute episodes is the v1 shape in `SCOPE.md`; both numbers are assumptions and
#: are labelled as such in the manifest, not smuggled in as facts.
STORY_COUNT_RESERVED: Final[int] = 60
STORY_MINUTES_EACH: Final[float] = 3.0
RADIO_EPISODE_COUNT_RESERVED: Final[int] = 20
RADIO_MINUTES_EACH: Final[float] = 7.0

#: Seconds of audio each pipeline is budgeted, derived from the numbers above so a
#: changed assumption changes the gate.
PIPELINE_RESERVED_SECONDS: Final[dict[str, float]] = {
    "lesson": LESSON_UTTERANCE_TARGET * LESSON_SECONDS_PER_UTTERANCE,
    "story": STORY_COUNT_RESERVED * STORY_MINUTES_EACH * 60.0,
    "radio": RADIO_EPISODE_COUNT_RESERVED * RADIO_MINUTES_EACH * 60.0,
}

#: The same reservations in bytes, which is the unit the manifest and the gate use.
PIPELINE_RESERVED_BYTES: Final[dict[str, int]] = {
    pipeline: int(seconds * BYTES_PER_SECOND_AT_BITRATE)
    for pipeline, seconds in PIPELINE_RESERVED_SECONDS.items()
}

#: The whole budget in bytes. `AUDIO_BUDGET_MB` is shared (`config/base.py`) because
#: G9 and the pack-detail screen read it too.
AUDIO_BUDGET_BYTES: Final[int] = AUDIO_BUDGET_MB * BYTES_PER_MB

#: What is left after the three reservations. Positive by construction today
#: (50.0 + 27.0 + 21.0 = 98.0 MB against 120); `tests/test_g8_bake.py` fails if a future
#: edit makes the three reservations exceed the budget, which is the arithmetic R13
#: found nobody had done.
BUDGET_HEADROOM_BYTES: Final[int] = AUDIO_BUDGET_BYTES - sum(PIPELINE_RESERVED_BYTES.values())
