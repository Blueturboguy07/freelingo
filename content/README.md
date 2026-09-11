# `content/` — course sources

Per-language, human-authored course sources. **Never a corpus, never a pack.**

```
content/<lang>/curriculum.yaml   original grammar inventory + unit titles (~1 human-day per language)
content/ja/characters.yaml       kana + kanji syllabary curriculum (stage G3b; not derivable from a corpus)
```

Everything here is **CC BY-NC-SA 4.0** — see [`LICENSE`](./LICENSE), and
[`../NOTICE`](../NOTICE) for why this differs from the code licence.

Corpora, frequency lists, aligned pairs and audio are downloaded, streamed and cached by
`tools/coursekit`; they are never committed. See [`../packs/README.md`](../packs/README.md).
