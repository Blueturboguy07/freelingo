# Back-translation consistency — the rubric G6 scores against (Spanish, v1)

`scope2/00` §2.3 gives G6 four checks, and the third is a **back-translation round trip**:
translate the authored Spanish back to English and compare it with the English the learner
will be shown. A round trip needs a translation model.

**There is no translation model here.** No API key exists in this environment for any
provider, and no local MT model is in the dependency set. The plan's ruling for exactly
this case is that the agent building the lane is the author, so this axis is:

> the agent's own judgement of whether the English a learner is shown is what the Spanish
> actually says, made against the scale below, recorded per candidate at authoring time,
> and read back by `coursekit.engines.backtranslation`.

That is **not a model round-trip**. The phrase is in the engine id
(`agent_rubric/v1 (agent-authored rubric score, not a model round-trip)`), in the G6
runlog entry, in V8's entry, and therefore in the pack manifest and on the pack detail
screen (INV-PACK-55). Nobody reading a Freelingo pack should be able to come to believe a
translation model checked these sentences, because none did.

When a real round trip becomes available it registers as another engine behind the same
interface, and the runlog starts naming that one instead. That swap is visible in the
artefact rather than silent, which is the whole point of INV-PACK-14.

## The scale

Score the **back-translation against the shown English translation**, not against the
Spanish. The question is always: _would a learner shown this English be misled about what
the Spanish says?_

| Score | Name                                  | Means                                                                                                                                                 | Ships? |
| ----- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0     | Contradicts                           | The round trip says something the Spanish does not say, or reverses it (negation, agent, direction).                                                  | No     |
| 1     | Fragmentary                           | The round trip is not a sentence, or loses a clause that carried meaning.                                                                             | No     |
| 2     | Drifts                                | The round trip is a sentence and means something else: a different sense of a polysemous word, a reflexive read as emphatic, an idiom read literally. | No     |
| 3     | Equivalent, with a surface difference | Same meaning. Differs only in article, number agreement on a mass noun, politeness register, or a fixed-phrase choice English makes differently.      | Yes    |
| 4     | Identical in meaning and register     | The round trip is the shown translation, or a paraphrase a reader would not notice.                                                                   | Yes    |

`BACKTRANSLATION_MIN_SCORE` is **3**. A candidate scored below it is discarded by G6 with
`reject_reason: g6:backtranslation` and the slot is filled by the next survivor. It is
never edited — INV-PACK-10, and the point of over-generating twenty per slot is that
there is always a next one.

## Why the line sits between 2 and 3

3 is where a difference stops being about meaning and starts being about English. Spanish
uses the definite article where English uses none (`el pan` / "bread"); English marks
politeness lexically where Spanish marks it in the verb. A learner shown "Good morning,
how are you?" for `Buenos días, ¿cómo está usted?` has lost the formality but not the
sentence, and no alternative English wording recovers it in four words.

2 is where the English stops being about the same event. `Nosotros nos llamamos Ana y
Carlos.` comes back as "We call ourselves Ana and Carlos" — a stage name, not an
introduction — and a learner drilling that pair learns the reflexive wrong. That is a
defect a native reviewer would count against the ≤2% gate, which is why it is caught here
and not there.

## Two worked judgements from this file

| Candidate                             | Shown English                      | Round trip                          | Score | Why                                                                                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------- | ----------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Nosotros nos llamamos Ana y Carlos.` | Our names are Ana and Carlos.      | We call ourselves Ana and Carlos.   | 2     | The reflexive reads as self-styling. A learner taking the round trip as the meaning learns `llamarse` wrong in the one lesson that teaches it.                                                                                                                    |
| `El pan de la cocina es nuevo.`       | The bread in the kitchen is fresh. | The bread of the kitchen is new.    | 2     | `nuevo` for bread is not "fresh" — `fresco` or `recién hecho` is. The shown English is what the author meant; the Spanish does not say it.                                                                                                                        |
| `¿Tú te llamas Ana?`                  | Is your name Ana?                  | Are you called Ana?                 | 3     | Same question, different English idiom. Nothing a learner is misled by.                                                                                                                                                                                           |
| `Buenos días, ¿cómo está usted?`      | Good morning, how are you?         | Good morning, how are you? (formal) | 3     | `usted` is unrecoverable in the shown English. Register lost, meaning intact.                                                                                                                                                                                     |
| `Buenas.`                             | Hello.                             | Hello. (clipped greeting)           | 3     | A clipped `Buenas tardes/noches`. English has no clipped greeting at all, so the shown English is the closest thing there is — a fixed-phrase choice English makes differently, which is what 3 is for. It is not 4: a learner is not told the Spanish is casual. |

## Scoring a one-word item

Founder ruling B9(b) makes a one-token candidate shippable for a lesson whose window
holds no verb, so the rubric is now asked to score `Hola.` and `Buenas.` as well as
sentences. The scale does not change and the question does not either — _would a learner
shown this English be misled about what the Spanish says?_ — but two of its rows need
reading carefully at this length:

- **1 (Fragmentary) is not the score for a short item.** "The round trip is not a
  sentence" is about a round trip that LOST a clause. `Hola.` is a complete utterance;
  "Hello." is a complete round trip of it. A greeting is not a fragment of a sentence.
- **3 rather than 4 is where the clipping goes.** `Buenas.` and `Hola, buenas.` are
  casual clippings with no English equivalent, so the shown English cannot carry the
  register. That is row 3's own case (`a fixed-phrase choice English makes differently`),
  and it is the same judgement the `usted` row above records from the other direction.

Everything else in `content/es/candidates/u01-l01.jsonl` is 4: `Buenos días.` /
"Good morning." is the round trip, word for word.

## What this rubric does not do

It is not a naturalness check — that is the KenLM band. It is not a grammar check — that
is the LanguageTool sidecar. It is not the native-speaker sample either: the ≤2%
wrong-item gate is measured by a paid reviewer on a stratified sample at the end of P2,
and this rubric is what should make that sample boring.

## Honest limits

- **One judge, no blind pass.** The same agent wrote the Spanish and scored the round
  trip. A judge marking their own work is a weaker instrument than an independent one,
  and the scores here should be read as a floor on quality rather than a measurement of
  it. The native-speaker sample is the measurement.
- **Scored at authoring time, not at build time.** If a candidate's `text` is edited the
  score goes stale. It cannot silently: the score is keyed by the exact text, and a
  candidate whose text is not in the scored set comes back as `None` from
  `AgentRubricEngine.score`, which is a rejection and not a default pass.
- **v1.** The version rides on every score (`rubric_version`), so a later rescoring under
  a changed scale is distinguishable rather than merged.
