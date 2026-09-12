# `content/es/authoring/`

Two files, and they are opposites. One is generated and authoritative about _what to
write_; the other is hand-made and authoritative about _nothing_.

| File                 | What it is                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `gap-brief.jsonl`    | a **derived snapshot** of one build's gap list, written by `coursekit gaps es`. Input for the four authoring lanes. |
| `axis-fixture.jsonl` | a **test fixture** for G5's five reject axes. Not course content, not read by any build.                            |

## `gap-brief.jsonl`

One JSON line per gap slot G4 could not fill from the corpus, plus a header line that
names the build it came from. Per row: the slot in G4's own key space, the unit's title
and function, the grammar concept, the lemmas the learner already has, the lemma the slot
is reserved to teach, the token window, and the `ledger_digest` an authored candidate has
to carry.

**`token_window` is per slot, and it is the number G5 enforces.** It is
`[3, 12]` on almost every row and `[1, 12]` on a slot whose permitted vocabulary contains
no lemma the G2 lexicon tags `VERB` or `AUX` — founder ruling B9(b), with
`verbless_window: true` beside it so a `1` does not read as a typo, and a
`verbless_slots` count on the header line. A lesson with no verb in its window cannot hold
a sentence in any language, so it holds words and fixed phrases instead (`Hola.`,
`Buenos días.`), which is what a level-1 lesson of the reference product is.

That row is the reason `u1/l1/s0 … s8` went unauthored through two rounds: the brief said
three tokens, three tokens of `{bueno, día, hola, noche, tarde}` is a word list, and two
independent lanes wrote the same eleven word lists and refused to ship them.

Regenerate it, never edit it:

```sh
cd tools/coursekit && uv run coursekit build es --only g4 && uv run coursekit gaps es
```

**G5 does not read this file, and must never be made to.** The enforcer is G5's
`stale_ledger` axis, which compares a candidate's `ledger_digest` against the ledger G4
emits _in the build being run_. If the brief could also enforce, a stale brief and a
stale candidates file would agree with each other and disagree with the course — the
second inlined notion of the ledger INV-PACK-40 forbids.
`tools/coursekit/tests/test_gaps_command.py` fails if any stage imports the command or
names this filename.

### Writing candidates against it

Twenty per slot (`MIN_CANDIDATES_PER_SLOT`), into your own shard:

```
content/es/candidates/<your-lane>.jsonl
```

One file per lane, read in sorted filename order after the legacy
`content/es/candidates.jsonl`. Two shards naming the same `(slot, text)` is a hard stop,
not a dedup — it would leave the slot nineteen deep while the floor still read twenty.

**Read order is not ship order, and guessing that it is will cost you an item.** G5
reports a slot filled by the FIRST accepted candidate it reads, so sorted filename order
is what decides that number. But `g7_expand.py` builds its lookup as
`candidates[key] = row` over every accepted row, so **G7 expands the LAST accepted
candidate for the slot**. If your shard and another lane's both have an accepted candidate
for one slot, G5's runlog names yours and the pack may ship theirs, silently. Two
consequences for you: keep exactly one admissible candidate per slot (the other nineteen
are over-generation and should fail a real axis), and do not assume a low-sorting filename
protects a slot from a shard that sorts after yours. This is a known defect recorded
against the expand lane in `docs/owned/p2r3-gapfill-lesson1.json`; until it is fixed,
content that accepts once per slot is content for which the two stages agree.

Each row:

```json
{
  "slot": { "unit_index": 5, "lesson_index": 27, "slot_index": 4 },
  "ledger_digest": "606cd3f645af7b27",
  "new_lemmas": ["hermano"],
  "text": "Mi hermano vive en Madrid.",
  "translation": "My brother lives in Madrid.",
  "author": "claude-opus-5 (agent; <lane>)",
  "generated_at": "2026-09-12",
  "provenance": "llm",
  "backtranslation": {
    "back_translation": "...",
    "score": 4,
    "judged_by": "agent",
    "rubric_version": "1"
  }
}
```

`slot`, `ledger_digest` and `new_lemmas` are copied from the brief row verbatim. The
digest is a witness, not a description: it cannot be edited into agreement with a ledger
it does not describe, which is the point of carrying it instead of a copy of the 928-lemma
allowed set.

### What the twenty are for, and what they are not

The twenty exist so that a candidate which fails an axis costs the next candidate and
nothing else (INV-PACK-10: discard and resample, never patch). So they have to be twenty
DISTINCT texts, and every one of them has to be a text the lane would ship if it were
admissible. A slot padded with the same string twenty times satisfies
`MIN_CANDIDATES_PER_SLOT` and defeats it.

They do **not** all have to be admissible, and in a tight window most of them are not.
`content/es/candidates/u01-l01.jsonl` is the extreme case and the honest shape of one:
nine slots, one admissible candidate each, and nineteen real level-1 greetings per slot
that reach outside the five-lemma window (`Buenos días, señora.`, `Hola, ¿cómo estás?`,
`Adiós, buenas noches.`) and are discarded `out_of_vocabulary`. That is what a generator
asked nine times for a greeting in this window actually produces, and the reject count it
generates is the measurement that says the window is five lemmas wide. Nothing in that
file is edited to fit, and none of the eleven word lists is in it.

**One admissible candidate per slot is a property worth keeping, not an accident.** G5
fills a slot with the FIRST accepted candidate; `g7_expand` builds its lookup with
`candidates[key] = row` over every accepted row, so G7 expands the LAST one. Two accepted
candidates for one slot therefore means the sentence G5 reports filled the slot and the
sentence the learner sees can be different rows, with nothing in either stage saying so.

## `axis-fixture.jsonl`

160 rows over 8 slots, hand-written before any build existed. It exercises all five of
G5's reject axes on purpose — `authoring_intent` says which each row is for: 112
`accept`, 19 `oov`, 16 `length`, 7 `budget`, 6 `duplicate`.

It lived at `content/es/candidates.jsonl` for a phase and was counted there as course
content: "8 of 918 gap slots covered, 0.9%". It covered **none**. Three independent
reasons, each fatal on its own:

1. **Its slot keys name nothing.** It numbers lessons per unit (`u2/l1/s1`); G4 numbers
   them globally across the course (unit 2 is lessons 7-12), so the same slot is
   `u2/l7/s1` there. The two key spaces do not intersect. G5 now fails on that by name
   rather than recording it in a note nobody read.
2. **Its ledgers are not ledgers.** `allowed_lemmas` holds surface forms — `llama`,
   `días`, `salgo`, `quier` — beside the lemmas. Nothing lemmatised them; they were
   written by hand.
3. **Its `new_lemmas` carry two entries.** A real gap reserves at most one new item,
   because that is V2's per-exercise budget. Seven of its rows exist _specifically_ to
   introduce two and be rejected, which only makes sense against a two-lemma gap.

So it is a fixture, and it is now filed as one. Deleting it would have been a loss: it is
the only committed corpus that makes four of G5's five axes fire, and
`tools/coursekit/tests/test_g5_gapfill.py` is the thing that keeps them honest. Filling
eight real slots of a shipping Spanish course with it would have been the loss.
