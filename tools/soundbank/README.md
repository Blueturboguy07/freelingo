# soundbank

Build-time synthesis of the Freelingo sound bank (plan §Art and sound: stings, fanfare,
the shimmer bus, the earcon). Nothing here ships in the app; it writes the audio files
that `art/` carries.

```bash
uv sync --project tools/soundbank
uv run --project tools/soundbank python <script>.py
uv run --project tools/soundbank pytest
```

## Why a second uv project

`tools/coursekit` is the content pipeline and its dependency tree is about text: typer,
and later spaCy/SudachiPy. Sound synthesis is numpy. Keeping them apart means a coursekit
run never resolves numpy and a sound bake never resolves a morphology stack — and
`pack-ci.yml`, which runs `coursekit validate`, stays as small as it is.

## Dependencies, and the one that is deliberately absent

| Package     | Why                                                                  |
| ----------- | -------------------------------------------------------------------- |
| `numpy`     | the cues are synthesised as float arrays; no DSP framework is needed |
| `soundfile` | writes those arrays to WAV (libsndfile, bundled in the wheel)        |

**There is no Python audio codec here on purpose.** Encoding is the system `ffmpeg`
(verified present at `/opt/homebrew/bin/ffmpeg`, which carries libopus); `opusenc` is not
installed on this machine, so ffmpeg is the Opus path for both the sound bank and the
`coursekit bake` transcode. A pip-installed encoder would be a second, differently
configured copy of a codec that is already here.

## Layout contract

This is a **virtual** uv project — no build backend, nothing is installed as a package.
Synthesis scripts live at the root of `tools/soundbank/`, tests in `tools/soundbank/tests/`,
and `pythonpath = ["."]` in `pyproject.toml` is what lets a test import a script. A later
task that wants a real `soundbank` package must add the build backend and the `src/`
layout together, the way `tools/coursekit` has them.
