"""Content-hashed item ids over the SEMANTIC fields only (INV-PACK-41).

An item id is the key a learner's FSRS row hangs off. It is a hash of what the item
*is*, never of where it sits or of how it is presented, because presentation changes on
a schedule nobody controls: JmdictFurigana ships a release on the 25th of every month, a
reviewer corrects an accepted alternate, the bake re-renders one clip, an illustration
is swapped. If any of that moved an id, every FSRS row under it would stop resolving —
the strength meter empties, `NEW WORD` comes back on a word the learner has known for
twelve weeks, and one word quietly carries two scheduler items (EC-PACK-38).

So the rule, from EC-PACK-38's ruling, is exact: hash over **prompt, preferred surface,
the lexeme/concept/grapheme tags and register**, and nothing else. Ruby spans, audio
hashes, stroke paths, illustration refs, the accepted-alternate set and the distractor
pool are outside it. A real semantic change is a new id plus an explicit old-to-new map,
not a silent re-hash.

The other half of the rule is that this file and
`packages/core/src/packs/items.ts` must agree to the byte. They are two implementations
in two languages, so they are pinned two ways: the field lists are read out of
`packages/schema/src/pack-schema.ts` (`tests/test_itemid.py`), and both sides assert the
same golden vector (`ITEM_ID_GOLDEN_OUTPUT` here, the same literal in
`pack-schema.test.ts`).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Any

from ..config.g9 import ITEM_ID_HEX_LENGTH, ITEM_ID_PREFIX, SEMANTIC_ITEM_FIELDS

__all__ = [
    "canonical_json",
    "item_id",
    "semantic_item_content",
]


def canonical_json(value: Any) -> str:
    """Keys sorted at every level, no whitespace, non-ASCII left as itself.

    Byte-for-byte what `canonicalJson` in `packages/core/src/packs/items.ts` produces:
    that function sorts object keys, preserves array order, and emits
    `JSON.stringify`-style escaping. `ensure_ascii=False` is what makes `¿Cómo estás?`
    hash the same on both sides — `ensure_ascii=True` would write `\\u00bfC\\u00f3mo`
    and every Spanish id would differ between the builder and the app.

    Array order is preserved rather than sorted, because an ordered list is content
    elsewhere in the pack. Where order must not matter — the tag arrays — the sorting is
    done in `semantic_item_content`, in both languages, at the same place.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def semantic_item_content(item: Mapping[str, Any]) -> dict[str, Any]:
    """The exact object that gets hashed: the six semantic fields, tag arrays sorted.

    Raises `KeyError` on a missing field rather than defaulting it. A default would make
    two genuinely different items hash the same — the one failure mode this whole module
    exists to prevent — and it would do so silently.
    """
    missing = [field for field in SEMANTIC_ITEM_FIELDS if field not in item]
    if missing:
        raise KeyError(
            f"semantic item is missing {', '.join(missing)}; the id is hashed over "
            f"{', '.join(SEMANTIC_ITEM_FIELDS)} and a defaulted field would collide two "
            f"different items onto one FSRS row"
        )
    content: dict[str, Any] = {}
    for field in SEMANTIC_ITEM_FIELDS:
        value = item[field]
        if isinstance(value, str):
            content[field] = value
        elif isinstance(value, Sequence):
            content[field] = sorted(str(entry) for entry in value)
        else:
            raise TypeError(f"semantic field {field} is {type(value).__name__}, not str or list")
    return content


def item_id(item: Mapping[str, Any]) -> str:
    """`i_` + 16 hex of sha256 over the canonical semantic content."""
    digest = hashlib.sha256(canonical_json(semantic_item_content(item)).encode()).hexdigest()
    return f"{ITEM_ID_PREFIX}{digest[:ITEM_ID_HEX_LENGTH]}"
