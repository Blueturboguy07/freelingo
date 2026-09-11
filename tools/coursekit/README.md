# coursekit

The Freelingo content pipeline. Stages **G0-G9** and validators **V1-V12** (plus the
Freelingo-specific validators) turn open corpora into a signed content pack.

```bash
uv sync
uv run pytest
uv run coursekit --help
```

## Commands

| Command                     | Does                                                                     | Lands |
| --------------------------- | ------------------------------------------------------------------------ | ----- |
| `coursekit build <lang>`    | G0-G9: corpus ledger -> selected items -> exercises -> units             | P2    |
| `coursekit validate <lang>` | V1-V12 + the Freelingo validators; nothing ships without a green run     | P2    |
| `coursekit bake <lang>`     | synthesize the voice cast and transcode to Opus, within the audio budget | P2    |
| `coursekit pack <lang>`     | assemble the read-only SQLite pack + manifest                            | P2    |
| `coursekit sample <lang>`   | draw the paid native-speaker sample                                      | P2    |
| `coursekit sign <lang>`     | sign the manifest with the ed25519 release key (INV-PACK-18)             | P2    |

Every command currently exits **2** with "not implemented yet". That is deliberate: a
half-built pipeline must never quietly produce a pack.

## Rules

- Every constant is in `coursekit/config.py`. No literal elsewhere.
- `INV-PACK-13`: the licence allow-list is checked **at ingest**, before G0 reads a byte.
  NonCommercial data is allowed into packs and forbidden in code; NoDerivatives is
  forbidden everywhere.
- Corpora are streamed and capped, never fully downloaded and never committed.
- Packs are CC BY-NC-SA 4.0; this tool is AGPL-3.0-only. See `../../NOTICE`.
