"""The pipeline's constants, and the only place a literal may live.

`base` holds what every stage shares. One submodule per stage holds what exactly one
stage tunes, and each of those is owned by the lane that implements that stage — so two
lanes working in the same wave never touch the same file to add a threshold.

Everything in `base` is re-exported here, so `from coursekit.config import LANGUAGES`
keeps working and no caller has to know which file a constant lives in.

The rule this package exists to enforce — no module-level constant anywhere outside
`coursekit/config/` — is executable, not a convention: `tests/test_cli.py` walks the
package with `ast` and fails on a violation. It was written that way because "keep the
constants together" is the kind of rule that is true on the day it is written and
quietly false four lanes later.
"""

from __future__ import annotations

from .base import (
    ARTIFACT_SCHEMA_VERSION,
    ARTIFACT_SUFFIX,
    AUDIO_BUDGET_MB,
    AUDIO_PIPELINES,
    BAKE_STAGE_ID,
    BUILD_ROOT_DIRNAME,
    BUILD_ROOT_ENV_VAR,
    BUILD_STAGE_IDS,
    CEFR_LANGUAGES,
    CI_SYNCED_GROUPS,
    CODE_LICENCE,
    DATA_SOURCE_KINDS,
    DEPENDENCY_GROUP_PROBES,
    DEPENDENCY_GROUPS,
    EXERCISE_TYPES,
    EXIT_FAILED,
    EXIT_MISSING_INPUT,
    EXIT_NOT_REGISTERED,
    EXIT_OK,
    EXIT_USAGE,
    GROUP_INSTALL_COMMAND,
    INGEST_LICENCE_ALLOW_LIST,
    ISO3_BY_LANGUAGE,
    L1,
    LANGUAGES,
    LOCALE_BY_LANGUAGE,
    MAX_DEFECT_RATE,
    OPUS_BITRATE_KBPS,
    PACK_LICENCE,
    PACK_STAGE_ID,
    PACK_TABLES,
    REVIEWER_SAMPLE_ITEMS,
    RUNLOG_FILENAME,
    SAMPLE_STAGE_ID,
    SIGN_STAGE_ID,
    SOURCES,
    STAGE_TITLES,
    TOOL_NAME,
    VALIDATOR_IDS,
    VALIDATOR_TITLES,
    Source,
    SourceKind,
    Verdict,
)

__all__ = [
    "ARTIFACT_SCHEMA_VERSION",
    "ARTIFACT_SUFFIX",
    "AUDIO_BUDGET_MB",
    "AUDIO_PIPELINES",
    "BAKE_STAGE_ID",
    "BUILD_ROOT_DIRNAME",
    "BUILD_ROOT_ENV_VAR",
    "BUILD_STAGE_IDS",
    "CEFR_LANGUAGES",
    "CI_SYNCED_GROUPS",
    "CODE_LICENCE",
    "DATA_SOURCE_KINDS",
    "DEPENDENCY_GROUP_PROBES",
    "DEPENDENCY_GROUPS",
    "EXERCISE_TYPES",
    "EXIT_FAILED",
    "EXIT_MISSING_INPUT",
    "EXIT_NOT_REGISTERED",
    "EXIT_OK",
    "EXIT_USAGE",
    "GROUP_INSTALL_COMMAND",
    "INGEST_LICENCE_ALLOW_LIST",
    "ISO3_BY_LANGUAGE",
    "L1",
    "LANGUAGES",
    "LOCALE_BY_LANGUAGE",
    "MAX_DEFECT_RATE",
    "OPUS_BITRATE_KBPS",
    "PACK_LICENCE",
    "PACK_STAGE_ID",
    "PACK_TABLES",
    "REVIEWER_SAMPLE_ITEMS",
    "RUNLOG_FILENAME",
    "SAMPLE_STAGE_ID",
    "SIGN_STAGE_ID",
    "SOURCES",
    "STAGE_TITLES",
    "TOOL_NAME",
    "VALIDATOR_IDS",
    "VALIDATOR_TITLES",
    "Source",
    "SourceKind",
    "Verdict",
]
