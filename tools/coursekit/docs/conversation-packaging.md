# Dialogue exposure at packaging and validation

Declared 2026-09-13. This consumer uses the reviewed conversation contract without
changing the exercise artefact or SQLite schema. Concrete G7 emission, G8 baking,
signing, the full pack gate and a listened sample remain separate required evidence.

G9 resolves every selected source from the current G0–G5 records, loads the explicit
conversation plan and requires its current successful G6 role approval. A missing
planned chat, changed question/reply/distractor, ambiguous source join or changed
original corpus record blocks packaging. Each chat audio reference must resolve to
its first-turn Spanish text in the correct language and lesson pipeline.

All unique corpus role rows enter the actual sentence table with original owners.
The existing signed meta table records `conversation:<exercise_id>` with role source
IDs, destination slot and review/population/plan hashes. Provenance percentages and
credits use these actual shipped rows. Reply-only item tags preserve canonical
teaching credit and FSRS identity; adding visible distractor words cannot add targets.

V1/V2 count every visible role lemma and the available role morphology. The existing
inflection warning severity is unchanged. The same expanded prerequisites drive the
actual G9 lesson ordering. V3/V4 retain canonical reply content, so a wrong answer
cannot provide recycling or target-coverage credit. V9 counts distinct role exposures
at their actual slots, collapses the canonical reply at its own slot and retains the
selected-slot denominator and existing repetition thresholds.

V10/V12 inspect additional role source licences and text, including stored English
translations. V11 keeps its original selected-source population and difficulty metric.
Only emitted chats add validator exposure; G6/G7/G9 separately enforce planned shape
coverage and current approval. There is no inferred empty authoring plan.

`test_pack_conversations.py` uses explicit independent mock reviews and the actual
shared approval loader, G9 caller and SQLite writer. Its errors cover missing plans,
failed newer G6 runs, changed roles and wrong/missing question audio. The historical
seven-exercise G9 fixture explicitly supplies an empty mock chat context to isolate
its existing SQLite/audio/licence checks; it does not certify production dialogue.
