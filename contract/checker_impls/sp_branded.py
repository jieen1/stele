"""Phase 0 + Phase 1 self-protection checkers (phase-language-config, *_uses_branded_type)."""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
from typing import Any

from sp_shared import *  # noqa: F401,F403

__all__ = [
    "_PHASE_LANGUAGE_VALID_KEYS",
    "_PHASE_LANGUAGE_VALID_VALUES",
    "phase_language_config_valid",
    "_BRANDED_TS_PACKAGES",
    "_iter_typescript_sources",
    "_scan_branded_field_assignments",
    "_RULE_ID_FIELD_RE",
    "_RULE_ID_SMART_CTORS",
    "_RULE_ID_CAST_BRANDS",
    "rule_id_uses_branded_type",
    "_SHA256_FIELD_RE",
    "_SHA256_SMART_CTORS",
    "_SHA256_CAST_BRANDS",
    "sha256_uses_branded_type",
    "_CONTRACT_PATH_FIELD_RE",
    "_CONTRACT_PATH_SMART_CTORS",
    "_CONTRACT_PATH_CAST_BRANDS",
    "_STELE_PATH_LITERAL_RE",
    "contract_path_uses_branded_type",
    "_CMD_NAME_CALL_RE",
    "_CMD_NAME_SMART_CTORS",
    "_CMD_NAME_CAST_BRANDS",
    "command_name_uses_branded_type",
    "_PACKAGE_NAME_FIELD_RE",
    "_PACKAGE_NAME_SMART_CTORS",
    "_PACKAGE_NAME_CAST_BRANDS",
    "package_name_uses_branded_type",
]




# ---------------------------------------------------------------------------
# Phase 0 (self-dogfooding plan) — per-phase language config consistency
# ---------------------------------------------------------------------------


_PHASE_LANGUAGE_VALID_KEYS = frozenset(
    {"trace", "type-state", "effect", "code-shape", "architecture"}
)


_PHASE_LANGUAGE_VALID_VALUES = frozenset(
    {"typescript", "python", "go", "rust", "java"}
)




def phase_language_config_valid(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify stele.config.json `phaseLanguages` is well-typed when present.

    Phase 0 (self-dogfooding plan): the per-phase language override field
    drives Phase B / architecture stage dispatch. Tolerating a typo there
    silently disables an entire stage at check-time. This checker mirrors
    the validation in `packages/cli/src/config/loadConfig.ts` so that
    `stele check` + pytest both surface the mistake.

    A missing `phaseLanguages` field is allowed (the project is using the
    targetLanguage everywhere).
    """
    config_path = _REPO_ROOT / "stele.config.json"
    if not config_path.exists():
        return {"passed": True, "message": "no config (acceptable for non-adopter mode)"}
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return {"passed": False, "message": f"stele.config.json unreadable: {exc}"}
    pl = raw.get("phaseLanguages")
    if pl is None:
        return {"passed": True, "message": None}
    if not isinstance(pl, dict):
        return {"passed": False, "message": "phaseLanguages must be an object"}
    for k, v in pl.items():
        if k not in _PHASE_LANGUAGE_VALID_KEYS:
            return {
                "passed": False,
                "message": (
                    f"phaseLanguages key `{k}` not in "
                    f"{sorted(_PHASE_LANGUAGE_VALID_KEYS)}"
                ),
            }
        if v not in _PHASE_LANGUAGE_VALID_VALUES:
            return {
                "passed": False,
                "message": (
                    f"phaseLanguages.{k} = `{v}` not in "
                    f"{sorted(_PHASE_LANGUAGE_VALID_VALUES)}"
                ),
            }
    return {"passed": True, "message": None}




# ---------------------------------------------------------------------------
# Phase 1 (self-dogfooding) — branded-id call-site enforcement
# ---------------------------------------------------------------------------
#
# These 5 checkers verify that every TypeScript source assignment of a
# branded-typed field goes through the matching smart constructor from
# `packages/core/src/util/branded-types.ts`. They are the self-dogfood
# of the type-driven evaluator: that evaluator already enforces the
# rule across an indexed TS program; these Python checkers are a
# defense-in-depth scan that runs without touching the TS toolchain so
# `pytest tests/contract` catches a regression even if `stele check`
# is bypassed.
#
# Conventions:
#  - Each checker scans `.ts` files under `packages/*/src/`, skipping
#    `dist/`, `node_modules/`, `tests/`, `*.d.ts`, and the canonical
#    `branded-types.ts` itself (which defines the smart constructors).
#  - Comment + string-literal interiors are blanked via
#    `_blank_string_interiors` so that the field-name regex never
#    matches inside a doc comment or a string literal.
#  - A "violation" is a `<field>:` assignment whose right-hand side is
#    a raw string/template literal (i.e. NOT wrapped in the matching
#    smart constructor, NOT a bare identifier reference, NOT an
#    explicit `as <Brand>` cast).

_BRANDED_TS_PACKAGES = (
    "core",
    "cli",
    "agent-hooks",
    "mcp-server",
    "architecture-core",
    "backend-typescript",
    "backend-python",
    "backend-go",
    "backend-rust",
    "backend-java",
    "call-graph-core",
    "trace-evaluator",
    "type-state-evaluator",
    "effect-evaluator",
    "type-driven-evaluator",
    "github-action",
    "claude-code-plugin",
)




def _iter_typescript_sources() -> list[pathlib.Path]:
    """Yield TS source files under packages/*/src/, deterministically sorted.

    Skips dist/, node_modules/, tests/, *.d.ts, and the canonical
    `branded-types.ts` (which is the source of the smart constructors).
    """
    out: list[pathlib.Path] = []
    for pkg in _BRANDED_TS_PACKAGES:
        src_root = _PACKAGES_DIR / pkg / "src"
        if not src_root.is_dir():
            continue
        for ts_file in src_root.rglob("*.ts"):
            parts = ts_file.parts
            if "node_modules" in parts or "dist" in parts:
                continue
            if "tests" in parts or "__tests__" in parts:
                continue
            if str(ts_file).endswith(".d.ts"):
                continue
            if ts_file.name == "branded-types.ts":
                continue
            out.append(ts_file)
    return sorted(out)




def _scan_branded_field_assignments(
    field_pattern: re.Pattern[str],
    smart_ctor_names: tuple[str, ...],
    cast_brand_names: tuple[str, ...],
) -> list[dict[str, Any]]:
    """Generic scanner: find `<field>: <value>` assignments where value
    is a raw string/template literal not wrapped in a smart ctor.

    Allowed forms (no violation):
      - `field: ctorName("literal")` / `field: ctorName(`tpl`)`
      - `field: someIdentifier` (variable typed elsewhere)
      - `field: someObj.member` / `field: arr[i]`
      - `field: value as Brand` cast
      - `field: ctor(...)` where `ctor` matches `smart_ctor_names`

    Violations:
      - `field: "raw string literal"`
      - field: backtick-raw-template-literal (template-literal form)
    """
    violations: list[dict[str, Any]] = []
    raw_re = re.compile(r"^\s*([\"`])")
    bare_ident_re = re.compile(r"^[A-Za-z_$][\w$.\[\]]*\s*[,;)}\n]?$")
    for src in _iter_typescript_sources():
        rel = str(src.relative_to(_REPO_ROOT))
        try:
            content = src.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        # We need to match field assignments in CODE only — comments
        # may contain illustrative examples like `rule_id: "stele:foo"`.
        # `_blank_string_interiors` blanks string contents but keeps the
        # surrounding quotes intact, so the field regex still anchors,
        # but the *interior* of a smuggled string is blanked. Comments
        # are kept intact in `_blank_string_interiors`; to also drop
        # comment text we strip comments first.
        code = _strip_ts_comments(content)
        for m in field_pattern.finditer(code):
            value_start = m.end()
            # Read up to the next `,`, `;`, newline, or `}`/`)` (whichever
            # comes first at the current paren/brace nesting depth = 0).
            depth = 0
            i = value_start
            n = len(code)
            while i < n:
                ch = code[i]
                if ch in "({[":
                    depth += 1
                elif ch in ")}]":
                    if depth == 0:
                        break
                    depth -= 1
                elif depth == 0 and ch in ",;\n":
                    break
                i += 1
            value_expr = code[value_start:i].strip()
            if not value_expr:
                continue
            # Wrapped in any of the allowed smart ctors?
            ctor_match = re.match(r"([A-Za-z_$][\w$]*)\s*\(", value_expr)
            if ctor_match and ctor_match.group(1) in smart_ctor_names:
                continue
            # Explicit `as Brand` cast?
            if any(value_expr.endswith(f" as {brand}") for brand in cast_brand_names):
                continue
            # Raw string or template literal — violation.
            if raw_re.match(value_expr):
                # Empty-string placeholder (e.g. `sha256: ""` set by a
                # caller after the object is built) — skip; the caller's
                # write site is the actual point where a smart-ctor is
                # required, not the struct literal.
                if value_expr in ('""', "''", "``"):
                    continue
                # Line number derived from the stripped code; the
                # comment-stripper preserves newlines so the count is
                # the same as in the original file.
                line_no = code.count("\n", 0, m.start()) + 1
                violations.append({
                    "file": rel,
                    "line": line_no,
                    "column": None,
                    "message": f"{m.group(0).strip()} {value_expr[:80]}",
                })
                continue
            # Bare identifier / member access — assumed typed elsewhere.
            if bare_ident_re.match(value_expr):
                continue
            # Object literal, array, ternary, etc. — accept conservatively.
            # The TypeScript evaluator (type-driven-evaluator) catches
            # the type-level violations; the Python checker only flags
            # the structurally-obvious raw-literal pattern.
    return violations




_RULE_ID_FIELD_RE = re.compile(r"\brule_id\s*[:=]\s*")


_RULE_ID_SMART_CTORS = ("ruleId",)


_RULE_ID_CAST_BRANDS = ("RuleId",)




def rule_id_uses_branded_type(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Phase 1.2 self-dogfooding: every `rule_id` field assignment in
    TS source must go through the `ruleId(...)` smart constructor (or
    be a bare variable / `as RuleId` cast). Raw string literals are
    rejected — that's the bypass the branded-id contract is meant to
    prevent.
    """
    violations = _scan_branded_field_assignments(
        _RULE_ID_FIELD_RE, _RULE_ID_SMART_CTORS, _RULE_ID_CAST_BRANDS,
    )
    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} `rule_id` site(s) bypass the ruleId() smart constructor: "
                + "; ".join(f"{v['file']}:{v['line']}" for v in violations[:5])
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




# Sha256-typed fields. The matcher scans field names that conventionally
# hold a SHA-256 value: `sha256`, `transitive_hash`, `contract_hash`,
# `own_hash`. The smart-ctor wrap accepts `sha256(...)`, `sha256Branded(...)`,
# `sha256SmartCtor(...)`, `computeSha256(...)`, `hashManifestSha256(...)`,
# `hashFile(...)`, `hashString(...)`, `sha256OfFileOrNull(...)`.
_SHA256_FIELD_RE = re.compile(r"\b(sha256|transitive_hash|contract_hash|own_hash)\s*:\s*")


_SHA256_SMART_CTORS = (
    "sha256",
    "sha256Branded",
    "sha256SmartCtor",
    "computeSha256",
    "hashManifestSha256",
    "hashFile",
    "hashString",
    "sha256OfFileOrNull",
)


_SHA256_CAST_BRANDS = ("Sha256",)




def sha256_uses_branded_type(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Phase 1.3 self-dogfooding: every assignment to a SHA-256-typed
    field (`sha256`, `transitive_hash`, `contract_hash`, `own_hash`)
    must go through one of the recognized hash factories. Raw string
    literals are forbidden — every hash should be computed from data
    in the same call, not pasted from elsewhere.
    """
    violations = _scan_branded_field_assignments(
        _SHA256_FIELD_RE, _SHA256_SMART_CTORS, _SHA256_CAST_BRANDS,
    )
    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} sha256/hash field site(s) bypass the sha256() smart constructor: "
                + "; ".join(f"{v['file']}:{v['line']}" for v in violations[:5])
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




# ContractPath: scan `entry:` (the SteleConfig contract entry) and
# `contractPath:` for `.stele` literals.
_CONTRACT_PATH_FIELD_RE = re.compile(r"\b(entry|contractPath|contract_path)\s*:\s*")


_CONTRACT_PATH_SMART_CTORS = ("contractPath",)


_CONTRACT_PATH_CAST_BRANDS = ("ContractPath",)


_STELE_PATH_LITERAL_RE = re.compile(r"^[\"`][^\"`]*\.stele[\"`]\s*$")




def contract_path_uses_branded_type(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Phase 1.4 self-dogfooding: every assignment to an `entry`,
    `contractPath`, or `contract_path` field whose value is a `.stele`
    string literal must be wrapped in `contractPath(...)`. Other fields
    named `entry` (CLI options, etc.) with non-stele values are out of
    scope — we only flag the literal-`.stele` form to avoid false
    positives across unrelated `entry:` fields.
    """
    raw_violations = _scan_branded_field_assignments(
        _CONTRACT_PATH_FIELD_RE,
        _CONTRACT_PATH_SMART_CTORS,
        _CONTRACT_PATH_CAST_BRANDS,
    )
    # Filter: only keep .stele literals (drop non-stele entry fields).
    violations = [
        v for v in raw_violations
        if _STELE_PATH_LITERAL_RE.match(v["message"].split(" ", 1)[-1].strip())
    ]
    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} `entry`/`contractPath` site(s) with raw .stele literal bypass the contractPath() smart constructor: "
                + "; ".join(f"{v['file']}:{v['line']}" for v in violations[:5])
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




# CommandName: scan `.command(...)` first arg + `new Command(...)` first
# arg. Both must be wrapped in `commandName(...)` or our local helper
# `cmdSpec(...)`. The acceptable callers are encoded in the smart-ctor
# allowlist; everything else is a violation.
_CMD_NAME_CALL_RE = re.compile(
    r"\.command\s*\(\s*|"   # `.command(`
    r"\bnew\s+Command\s*\(\s*"  # `new Command(`
)


_CMD_NAME_SMART_CTORS = ("commandName", "cmdSpec")


_CMD_NAME_CAST_BRANDS = ("CommandName",)




def command_name_uses_branded_type(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Phase 1.5 self-dogfooding: every `program.command(...)` and
    `new Command(...)` call in CLI source must construct its command
    name through `commandName(...)` (or the local `cmdSpec(...)`
    helper in `packages/cli/src/index.ts`, which validates the name
    internally). Raw string literals are forbidden — they bypass the
    CommandName brand the type-driven evaluator enforces.
    """
    violations: list[dict[str, Any]] = []
    raw_re = re.compile(r"^\s*([\"`])")
    for src in _iter_typescript_sources():
        rel = str(src.relative_to(_REPO_ROOT))
        try:
            content = src.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        code = _strip_ts_comments(content)
        for m in _CMD_NAME_CALL_RE.finditer(code):
            value_start = m.end()
            # Read the first comma-or-paren-terminated argument.
            depth = 0
            i = value_start
            n = len(code)
            while i < n:
                ch = code[i]
                if ch in "({[":
                    depth += 1
                elif ch in ")}]":
                    if depth == 0:
                        break
                    depth -= 1
                elif depth == 0 and ch == ",":
                    break
                i += 1
            value_expr = code[value_start:i].strip()
            if not value_expr:
                continue
            ctor_match = re.match(r"([A-Za-z_$][\w$]*)\s*\(", value_expr)
            if ctor_match and ctor_match.group(1) in _CMD_NAME_SMART_CTORS:
                continue
            if any(value_expr.endswith(f" as {brand}") for brand in _CMD_NAME_CAST_BRANDS):
                continue
            if raw_re.match(value_expr):
                line_no = code.count("\n", 0, m.start()) + 1
                violations.append({
                    "file": rel,
                    "line": line_no,
                    "column": None,
                    "message": f"{m.group(0).strip()} {value_expr[:80]}",
                })
    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} command name site(s) bypass the commandName() / cmdSpec() helper: "
                + "; ".join(f"{v['file']}:{v['line']}" for v in violations[:5])
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




# PackageName: scan `packageName:` field assignments in the cli's
# backend-registry.
_PACKAGE_NAME_FIELD_RE = re.compile(r"\bpackageName\s*:\s*")


_PACKAGE_NAME_SMART_CTORS = ("packageName", "toPackageName")


_PACKAGE_NAME_CAST_BRANDS = ("PackageName",)




def package_name_uses_branded_type(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Phase 1.6 self-dogfooding: every `packageName:` field assignment
    in TS source must be wrapped in `packageName(...)` (imported as
    `toPackageName(...)` where it collides with a local field). Raw
    string literals are forbidden so that a future agent dropping the
    `@stele/...` scope or typo'ing a backend name fails the contract.
    """
    violations = _scan_branded_field_assignments(
        _PACKAGE_NAME_FIELD_RE,
        _PACKAGE_NAME_SMART_CTORS,
        _PACKAGE_NAME_CAST_BRANDS,
    )
    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} `packageName` site(s) bypass the packageName() smart constructor: "
                + "; ".join(f"{v['file']}:{v['line']}" for v in violations[:5])
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}
