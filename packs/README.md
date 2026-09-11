# Content packs

A **content pack** is what a course actually is: a read-only SQLite database (lexemes,
grammar concepts, sentences with provenance and per-sentence attribution, exercises,
units, stories, radio episodes, character lessons, audio rows, meta), a content-addressed
Opus audio bank, and a **signed manifest** carrying the validator report, the measured
defect rate and the full licence/attribution table.

Packs are **not** in this repository. They are built by `tools/coursekit`, signed with the
ed25519 release key, and published as GitHub Release assets. This directory holds the
documentation and, later, the pack index — never a pack, never a corpus.

## Licence — CC BY-NC-SA 4.0

> **Freelingo content packs are licensed under
> [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-nc-sa/4.0/).**
> The full text is in [`../content/LICENSE`](../content/LICENSE).

This is deliberately **not** the licence of the app. The code is AGPL-3.0-only; see
[`../NOTICE`](../NOTICE) for why the split exists and what it means for a fork.

The short version: packs may embed CEFRLex-derived grading and other NonCommercial or
ShareAlike sources, which an AGPL codebase could not carry. So the licence allow-list is
enforced **per artefact**:

| Artefact                              | NC data     | ND data   | SA data                                       |
| ------------------------------------- | ----------- | --------- | --------------------------------------------- |
| Code (`packages/`, `apps/`, `tools/`) | forbidden   | forbidden | case by case                                  |
| Content packs                         | **allowed** | forbidden | allowed, declared share-alike in the manifest |

`INV-PACK-13` enforces the allow-list **at ingest**, before the first byte of a corpus is
read. A pack whose manifest cannot account for every source does not build.

## Attribution

Every sentence that requires attribution carries its owner string in the pack and is
reachable from a rendered surface — the report sheet and the About/credits screen
(`INV-PACK-17`). Attribution is not a footnote in a README; it is a product surface.

## Signing key custody

Generated at P0 (2026-09-11), ed25519, one key for all packs.

| Half                   | Where it lives                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **private** (signing)  | the `PACK_SIGNING_KEY` Actions secret on `Blueturboguy07/freelingo`. Nowhere else.                                           |
| **public** (verifying) | [`../packages/schema/keys/pack-signing.pub`](../packages/schema/keys/pack-signing.pub), committed and shipped inside the app |

The private half was written to disk once, uploaded, and removed with `rm -P`; it was never
printed and has no backup. **Losing it means a new key and a new app release**, not a lost
pack: re-signing is cheap, but an installed app only trusts the key it shipped with.

`packages/schema/src/signing.ts` holds the filename, the secret name and a parser that
refuses anything that is not an ed25519 SPKI — the substitution a plain "the file exists"
check would miss. `packages/schema/src/signing.test.ts` holds it against `node:crypto`.

Verification itself — verify **before** install, an invalid signature mapping to
`unverified` and never to `corrupt` (`INV-PACK-18`) — lands at P2 with the pack installer.
There is no verify function yet on purpose; a half-written one is what a later phase would
end up trusting.

## Pack states

A pack on a device is in exactly one of six states:
`not-downloaded`, `partial`, `installed`, `corrupt`, `unverified`, `withdrawn`.
An invalid signature is `unverified`, never `corrupt`.
