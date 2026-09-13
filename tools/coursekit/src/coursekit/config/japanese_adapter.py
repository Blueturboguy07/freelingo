"""Exact Japanese preparation pins, 2026-09-13; no experimental UI constants."""

from typing import Final

SPACY_POS_VERSION: Final[str] = "3.8.16"
# Original probes measured on the exact installed models on 2026-09-13.
# Hashes include every source token, dictionary-linked reading, C span, and tts
# candidate. These freeze observed output, including known contextual reading errors.
JAPANESE_SELFTEST: tuple[tuple[str, str], ...] = (
    ("国家公務員です。", "78c8cf6faa138964c435ed9fc8d05ce2b446894791254ea3fd9c387abd53820c"),
    ("朝ご飯を食べます。", "30272717dbb7ea99c72c188f39e152bc485d9d0754666609a6f90fb560caa939"),
    ("私は学生です。", "9469cc19598421c079e781a88f6d4a6b9e384814b2f033824c9088c4a4822cb0"),
    ("この本は赤いです。", "c64d51d1284cf7f357bdcc6156a0cffc54ca20634f8d404cab32d0e7926f9115"),
    ("明日は学校に行きます。", "f81edba7b635066e12160139e1b21338883b28c8acb15523af20599f228a24c3"),
    ("コーヒーを飲みます。", "dcf7fc328d0d9284b8e5563663f46a49353587ea9b7a756e10ee0334ee038a54"),
    ("図書館で本を読みます。", "adf4ea8d1df375571471deb6301744415bb1df9e8a9217fddcd444e20eb76e91"),
    ("母は家にいます。", "b4ecd75befdb07ffb35a16dc4950cbb1be178a73a48c023799abcd2a378cf13d"),
    (
        "お名前を教えてください。",
        "0fd9d1a3f157444b07346785a62d0d21c9f6182dc9c6e2b4aa65efd2361d7809",
    ),
    (
        "先生がいらっしゃいます。",
        "6fd83e75c09e0a4674ec20825aefc8906ed2f7671e63e511ba59b684f599d641",
    ),
    ("辛いカレーを食べます。", "b8332afd14d20353bed38a29c47cb96ef99ab721daf2930411d6124f3ad850d5"),
    ("試験は辛いです。", "ae3fd9ed1980a0aaa87feb2081002d4d3d0eb57a5d02c7e08ff96c8bed2e2865"),
    (
        "「こんにちは」と言います。",
        "1d5d953d8c0c6d68801906b2654f67a82ad1a1ffc2caf3998f62be2187c5ccc7",
    ),
    ("水を飲んでいます。", "37594a0a235ce6dceb6ef903e59f5d15620f1e6a2b863baae49752603d1d91f8"),
    ("大きな犬がいます。", "cc2dcbaebe7656bf9cf787d92cfb7b61c55eaa216f47bacffc001598fbd29c22"),
)
JAPANESE_SELFTEST_DIGEST: Final[str] = (
    "ffdba66a414fc859313477404b6f65d9dc54200d6f96d4ffc7355607a47e96e4"
)
