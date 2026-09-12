"""The CLI contract, the registry contract, and the no-literal-outside-config rule.

The load-bearing test in here is `test_exit_two_is_not_vacuous`. Everything else in a
scaffold can be wrong and get caught later; a `build` that exits 0 with no stages
registered produces no pack, says nothing, and reads as a fast build — and the thing
downstream of it is a file a learner installs.
"""

from __future__ import annotations

import ast
import tomllib
from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

from coursekit.cli import app
from coursekit.config import (
    AUDIO_BUDGET_MB,
    AUDIO_PIPELINES,
    BUILD_STAGE_IDS,
    CEFR_LANGUAGES,
    CI_SYNCED_GROUPS,
    DEPENDENCY_GROUPS,
    EXIT_FAILED,
    EXIT_MISSING_INPUT,
    EXIT_NOT_REGISTERED,
    EXIT_OK,
    EXIT_USAGE,
    LANGUAGES,
    LOCALE_BY_LANGUAGE,
    MAX_DEFECT_RATE,
    OPUS_BITRATE_KBPS,
    VALIDATOR_IDS,
)
from coursekit.stages import STAGES, StageContext, StageResult, register_stage
from coursekit.validators import VALIDATORS, Finding, ValidatorContext, register_validator

runner = CliRunner()

COMMANDS = ["build", "validate", "bake", "pack", "sample", "sign"]
PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "src" / "coursekit"
PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


# ---------------------------------------------------------------------------
# Shape
# ---------------------------------------------------------------------------


def test_help_lists_every_stage() -> None:
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == EXIT_OK
    for command in COMMANDS:
        assert command in result.output


@pytest.mark.parametrize("command", COMMANDS)
def test_unknown_language_is_rejected(command: str) -> None:
    result = runner.invoke(app, [command, "kl"])
    assert result.exit_code == EXIT_USAGE, result.output


def test_unknown_stage_id_is_usage_not_unregistered() -> None:
    """`--only g99` is a typo, not an unwritten stage. Those get different codes."""
    result = runner.invoke(app, ["build", "es", "--only", "g99"])
    assert result.exit_code == EXIT_USAGE, result.output


def test_unknown_validator_id_is_usage_not_unregistered() -> None:
    result = runner.invoke(app, ["validate", "es", "--only", "V99"])
    assert result.exit_code == EXIT_USAGE, result.output


def test_set_option_requires_key_equals_value() -> None:
    result = runner.invoke(app, ["build", "es", "--set", "nonsense"])
    assert result.exit_code == EXIT_USAGE, result.output


# ---------------------------------------------------------------------------
# The exit-2 rule
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("empty_registry")
@pytest.mark.parametrize("command", COMMANDS)
def test_unregistered_stage_exits_two_never_zero(command: str) -> None:
    result = runner.invoke(app, [command, "es"])
    assert result.exit_code == EXIT_NOT_REGISTERED, result.output


@pytest.mark.usefixtures("empty_registry")
def test_unregistered_message_names_what_is_missing() -> None:
    """Exit 2 alone tells a lane nothing. The output names every missing stage."""
    result = runner.invoke(app, ["build", "es"])
    assert result.exit_code == EXIT_NOT_REGISTERED
    for stage_id in BUILD_STAGE_IDS:
        assert stage_id in result.output


def test_exit_two_is_not_vacuous(empty_registry: None) -> None:
    """2 with nothing registered, 0 with everything, 2 again with one removed.

    Without the middle step, `test_unregistered_stage_exits_two_never_zero` would still
    pass if the dispatcher exited 2 unconditionally — which is the same bug in the
    other direction, and would hide a working pipeline behind a permanent failure.
    """

    def noop(ctx: StageContext) -> StageResult:
        ctx.entry.note(fake=True)
        return StageResult(ok=True)

    assert runner.invoke(app, ["build", "es"]).exit_code == EXIT_NOT_REGISTERED

    for stage_id in BUILD_STAGE_IDS:
        register_stage(stage_id)(noop)
    result = runner.invoke(app, ["build", "es"])
    assert result.exit_code == EXIT_OK, result.output

    STAGES._entries.pop("g4")  # noqa: SLF001 — removing one is the point of the test
    result = runner.invoke(app, ["build", "es"])
    assert result.exit_code == EXIT_NOT_REGISTERED, result.output
    assert "g4" in result.output


def test_a_failing_stage_exits_four_not_two(empty_registry: None) -> None:
    """A stage that ran and failed is a different problem from one nobody wrote."""

    def ok(ctx: StageContext) -> StageResult:
        return StageResult(ok=True)

    def broken(ctx: StageContext) -> StageResult:
        return StageResult(ok=False, message="the ledger is empty")

    for stage_id in BUILD_STAGE_IDS:
        register_stage(stage_id)(broken if stage_id == "g2" else ok)

    result = runner.invoke(app, ["build", "es"])
    assert result.exit_code == EXIT_FAILED, result.output
    assert "the ledger is empty" in result.output


def test_a_stage_needing_an_absent_group_exits_three(empty_registry: None) -> None:
    """Exit 3, with the install command — never a degraded run.

    `align` and `tts` are not synced by CI, so this is the code a CI runner sees if a
    stage that needs torch ever reaches the dispatcher.
    """

    def ok(ctx: StageContext) -> StageResult:
        return StageResult(ok=True)

    for stage_id in BUILD_STAGE_IDS:
        register_stage(stage_id, requires_group="align" if stage_id == "g7" else None)(ok)

    result = runner.invoke(app, ["build", "es"])
    if result.exit_code == EXIT_OK:
        pytest.skip("the align group is installed in this environment")
    assert result.exit_code == EXIT_MISSING_INPUT, result.output
    assert "uv sync --group align" in result.output


@pytest.mark.usefixtures("empty_registry")
def test_validate_refuses_while_a_validator_is_missing() -> None:
    def clean(ctx: ValidatorContext) -> list[Finding]:
        return []

    for validator_id in VALIDATOR_IDS[:-1]:
        register_validator(validator_id)(clean)

    result = runner.invoke(app, ["validate", "es"])
    assert result.exit_code == EXIT_NOT_REGISTERED, result.output
    assert VALIDATOR_IDS[-1] in result.output


def test_validate_runs_every_validator_before_deciding(empty_registry: None) -> None:
    """One blocking finding does not stop the suite; the reviewer sees all of them."""
    seen: list[str] = []

    def make(validator_id: str, blocking: bool):
        def run(ctx: ValidatorContext) -> list[Finding]:
            seen.append(validator_id)
            if not blocking:
                return []
            return [
                Finding(
                    validator_id=validator_id,
                    severity="blocking",
                    message=f"{validator_id} says no",
                )
            ]

        return run

    for index, validator_id in enumerate(VALIDATOR_IDS):
        register_validator(validator_id)(make(validator_id, blocking=index in (0, 5)))

    result = runner.invoke(app, ["validate", "es"])
    assert result.exit_code == EXIT_FAILED, result.output
    assert seen == list(VALIDATOR_IDS)
    assert f"{VALIDATOR_IDS[0]} says no" in result.output
    assert f"{VALIDATOR_IDS[5]} says no" in result.output


def test_a_clean_validator_suite_exits_zero(empty_registry: None) -> None:
    def clean(ctx: ValidatorContext) -> list[Finding]:
        return []

    for validator_id in VALIDATOR_IDS:
        register_validator(validator_id)(clean)
    result = runner.invoke(app, ["validate", "es"])
    assert result.exit_code == EXIT_OK, result.output


def test_doctor_always_exits_zero() -> None:
    """A diagnostic that can fail is a diagnostic people stop running."""
    result = runner.invoke(app, ["doctor", "es"])
    assert result.exit_code == EXIT_OK, result.output
    assert "align" in result.output
    assert "NOT synced by CI" in result.output


# ---------------------------------------------------------------------------
# Registry hygiene
# ---------------------------------------------------------------------------


def test_a_stage_id_outside_the_ledger_is_refused(empty_registry: None) -> None:
    """A registered stage that `build` never runs looks exactly like a broken stage."""
    with pytest.raises(ValueError, match="not a stage in the ledger"):
        register_stage("g42")(lambda ctx: StageResult())


def test_a_validator_id_outside_the_ledger_is_refused(empty_registry: None) -> None:
    with pytest.raises(ValueError, match="not a validator in the ledger"):
        register_validator("V42")(lambda ctx: [])


def test_registering_the_same_stage_twice_raises(empty_registry: None) -> None:
    """Shadowing reads as 'my code isn't running' for an afternoon. Raise instead."""
    register_stage("g0")(lambda ctx: StageResult())
    with pytest.raises(RuntimeError, match="registered twice"):
        register_stage("g0")(lambda ctx: StageResult())


def test_discovery_finds_nothing_yet_and_that_is_the_correct_state() -> None:
    """P2 wave 2 registers the stages. Today the packages are registries only.

    Asserted rather than left implicit so the day a lane lands `coursekit/stages/g0.py`
    this test is the thing that tells them the wiring worked.
    """
    assert STAGES.missing(BUILD_STAGE_IDS) == BUILD_STAGE_IDS
    assert VALIDATORS.missing(VALIDATOR_IDS) == VALIDATOR_IDS


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def test_config_constants_match_the_plan() -> None:
    assert LANGUAGES == ("es", "fr", "de", "ja")
    assert set(LOCALE_BY_LANGUAGE) == set(LANGUAGES)
    assert OPUS_BITRATE_KBPS == 20
    assert MAX_DEFECT_RATE == 0.02
    # CEFR is claimed only where a CEFRLex resource exists (Q8 ruling).
    assert CEFR_LANGUAGES == ("es", "fr")


def test_the_audio_budget_is_the_re_declared_one() -> None:
    """120 MB, not the 35-40 MB the spec inherited.

    The adversarial review (R13) showed 35-40 MB over ~8,000 utterances is 4.4 KB each,
    about 14 kbps for a 2.5-second clip, which no codec delivers intelligibly; the plan
    re-declared the budget rather than quietly dropping the utterance count. And R14
    showed the same figure counted lessons only, so the budget covers all three
    pipelines — which is what INV-PACK-15 asserts.
    """
    assert AUDIO_BUDGET_MB == 120
    assert AUDIO_PIPELINES == ("lesson", "story", "radio")


def test_ci_synced_groups_match_pyproject() -> None:
    """`pack-ci.yml` runs `uv sync --locked`, which installs `[tool.uv] default-groups`.

    If that list and `CI_SYNCED_GROUPS` drift, the tool believes CI carries a group it
    does not — and a stage that should have exited 3 with an install command instead
    dies on an ImportError in a 20-minute job.
    """
    pyproject = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    declared = tuple(pyproject["tool"]["uv"]["default-groups"])
    assert declared == CI_SYNCED_GROUPS
    heavy = set(DEPENDENCY_GROUPS) - set(CI_SYNCED_GROUPS)
    assert heavy == {"align", "tts"}


def test_every_optional_group_is_declared_in_pyproject() -> None:
    pyproject = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    groups = set(pyproject["dependency-groups"])
    assert set(DEPENDENCY_GROUPS) <= groups


def test_the_spacy_model_is_pinned_by_url_not_by_name() -> None:
    """`spacy download` resolves against a live manifest.

    A lemmatiser change re-partitions the ledger and can retro-introduce a lemma before
    its introduction unit — a V1 failure that is invisible to every test downstream of
    G2, because every one of them agrees with the new lemmatiser.
    """
    pyproject = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    source = pyproject["tool"]["uv"]["sources"]["es-core-news-md"]
    assert source["url"].endswith("es_core_news_md-3.8.0-py3-none-any.whl")


def test_kenlm_is_pinned_to_a_commit_not_to_master() -> None:
    """`archive/master.zip` is a moving target inside a lockfile.

    Same class of hazard as the spaCy pin: a perplexity band computed against one build
    of KenLM and enforced against another is a V8 that drifts with no diff.
    """
    pyproject = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    url = pyproject["tool"]["uv"]["sources"]["kenlm"]["url"]
    assert "/archive/master.zip" not in url
    assert url.rstrip(".zip").split("/")[-1].isalnum()
    assert len(url.rstrip(".zip").split("/")[-1]) == 40


# ---------------------------------------------------------------------------
# The rule the config package exists for
# ---------------------------------------------------------------------------

#: The complete exception list, and it is meant to stay this short.
#:
#: A JSON Schema is a CONTRACT, not a tunable: it belongs beside the code that enforces
#: it, it is versioned by `contract_digest()`, and moving it into `config/` would put a
#: 200-line document in the file people read to find a threshold. The artefact schemas
#: escape the rule anyway because they are built by a call; this one is a dict literal
#: and has to be named.
_ALLOWED_OUTSIDE_CONFIG = {"RUNLOG_SCHEMA"}


def _literal_constants(path: Path) -> list[str]:
    """Public UPPER_CASE module-level names bound to a LITERAL, outside `config/`.

    Three deliberate exclusions, each of which would otherwise make the rule useless:

    - **Private names.** Nothing outside the module can read `_NONEMPTY`, so it is not
      a constant anyone tunes against the spec.
    - **Anything bound to a call or a comprehension.** `Registry(...)`,
      `Draft202012Validator(...)`, `TypeVar(...)`, `_object(...)` and the `ARTIFACTS`
      dict comprehension are constructed objects. A registry singleton in
      `stages/__init__.py` is the module's whole purpose, not a threshold hiding from
      review.
    - **Dunders.** `__all__` is lowercase to `str.isupper()` already.

    What is left is exactly what the README rule is about: a number, a string, or a
    collection of them, sitting next to the code that reads it where nobody reviewing
    the spec will find it.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: list[str] = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets, value = list(node.targets), node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        else:
            continue
        if not _is_literal(value):
            continue
        for target in targets:
            if not isinstance(target, ast.Name):
                continue
            if target.id.startswith("_") or not target.id.isupper():
                continue
            found.append(target.id)
    return found


def _is_literal(node: ast.expr) -> bool:
    """A constant, or a tuple/list/set/dict built only out of them."""
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, ast.Tuple | ast.List | ast.Set):
        return all(_is_literal(element) for element in node.elts)
    if isinstance(node, ast.Dict):
        return all(
            key is not None and _is_literal(key) and _is_literal(value)
            for key, value in zip(node.keys, node.values, strict=True)
        )
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return _is_literal(node.operand)
    return False


def test_no_constant_lives_outside_config() -> None:
    """The README rule, made executable.

    "Keep the constants together" is true on the day it is written and quietly false
    four lanes later, and a threshold that lives next to the code that reads it is a
    threshold nobody can review against the spec.
    """
    offenders: list[str] = []
    for path in sorted(PACKAGE_ROOT.rglob("*.py")):
        if path.parent.name == "config":
            continue
        for name in _literal_constants(path):
            if name in _ALLOWED_OUTSIDE_CONFIG:
                continue
            offenders.append(f"{path.relative_to(PACKAGE_ROOT)}:{name}")
    assert offenders == [], (
        "module-level constants outside coursekit/config/: "
        + ", ".join(offenders)
        + ". Move them into config/<stage>.py (the stage's own) or config/base.py "
        "(shared by more than one stage)."
    )


def test_the_rule_would_catch_a_violation(tmp_path: Path) -> None:
    """The falsifier. Without it the test above passes on an empty rglob, and the three
    exclusions above are each a way for it to stop seeing anything at all."""
    planted = tmp_path / "planted.py"
    planted.write_text(
        "MAX_RETRIES = 3\n"
        "BANDS = ('A1', 'A2')\n"
        "THRESHOLDS = {'es': 0.4}\n"
        "_PRIVATE = 3\n"
        "REGISTRY = dict()\n"
        "lower = 3\n",
        encoding="utf-8",
    )
    assert _literal_constants(planted) == ["MAX_RETRIES", "BANDS", "THRESHOLDS"]
    assert _literal_constants(PACKAGE_ROOT / "config" / "base.py"), (
        "the walker found no constants in config/base.py, so it is not walking anything"
    )


def test_exit_codes_are_distinct() -> None:
    codes = [EXIT_OK, EXIT_USAGE, EXIT_NOT_REGISTERED, EXIT_MISSING_INPUT, EXIT_FAILED]
    assert len(set(codes)) == len(codes)
    assert EXIT_OK == 0
    assert EXIT_NOT_REGISTERED == 2


def test_fail_returns_an_exit_rather_than_raising() -> None:
    """`fail()` is `raise fail(...)` at every call site; a helper that raised would
    make the control flow invisible to a reader and to a type checker."""
    from coursekit.commands import fail

    assert isinstance(fail("x", EXIT_USAGE), typer.Exit)
