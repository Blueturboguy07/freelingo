# Japanese analysis preparation

This P7 slice prepares Japanese source evidence. It has not run a corpus, produced a
Japanese pack, or passed linguistic, audio, sample, native or release gates.

`adapters.sudachi_identity.resolve_lemma_identity(morpheme, dictionary)` follows the
exact dictionary-form word ID from the source morpheme and matches both dictionary ID
and word ID in the dictionary lookup result. It never selects the first spelling
match. Lexical OOV entries, absent/duplicate links and conflicting normalized forms
or POS reject. The helper preserves the raw analyzer normalized form while deriving
`lemma` with the shared ledger normalization. It stores the linked lemma reading
separately from the source morpheme reading. The implementation pins SudachiPy0.6.11
and sudachidict-core20260723; `get_word_info()` is deprecated in that exact API and
must be revalidated before changing these pins.

The measured model chooses ツライ in 辛いカレー. Exact dictionary linkage preserves
that chosen identity; it does not certify the contextually correct pronunciation.
Sudachi's synthetic numeral 三 is OOV in 三本あります and is rejected by the current
strict identity helper. Counter and reading policy therefore remain required work.

`japanese_script.build_script_analysis(analysed, *, text, mode_c_tokens,
mode_a_surface_readings, tts_reading)` constructs paired structural evidence from
supplied analyzer output. `validate_script_analysis(script, analysed, *, text)`
returns a frozen `ScriptProjection` with the Mode-A-to-Mode-C index tuple. The caller
must provide the exact source text from the ingested record, not reconstruct it from
tokens. Source ID, text SHA256, complete G1 analysis digest and adapter are bound.
Both token partitions must cover the source exactly except whitespace; every Mode A
token must be contained in exactly one Mode C token. The G1 lemma sequence and lexical
Mode C display list must agree with the stored tokens under the shared ledger policy.
Offsets are Python Unicode codepoint indices, matching G1; runtime UTF-16 conversion
must happen explicitly at the later consumer boundary.

Token.reading is the dictionary-linked lemma reading. The paired
`mode_a_surface_readings` are the original inflected source readings and intentionally
need not equal Token.reading. `tts_reading` is a nonempty kana pronunciation candidate,
never a fallback to display kanji. All these script rows have
`reading_review_status="unreviewed"`; the structural validator refuses self-declared
review. Independent contextual review and actual speech evidence remain separate.

The paired script artifact registration and G1 population persistence are pending
shared-contract integration. The actual Sudachi Mode A/C adapter and frozen self-test
are the next slice. G2 still groups by lemma/POS without reading and cannot yet preserve
Japanese homograph identities. Do not run Japanese G2 or infer kit readiness from these
helpers. French/German measured adapter probes likewise freeze observed model output;
they do not certify a language pack or cure known linguistic tagging errors.
