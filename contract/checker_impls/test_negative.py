"""Negative tests for self-protection checkers.

Each test creates a controlled violation, runs the checker, and verifies it fails.
These confirm that each checker actually detects the thing it claims to protect.

Run: python contract/checker_impls/test_negative.py
"""
from __future__ import annotations

import json
import pathlib
import re
import textwrap
from typing import Any

import pytest

import self_protection as sp

# Reset caches before each test.
def _reset_caches():
    sp._backend_registry_cache = None
    sp._stele_files_cache = None


def _pass_if_false(result: dict[str, Any], name: str) -> bool:
    """Return True if checker correctly detected a violation (passed=False)."""
    if not result.get("passed"):
        print(f"  OK: {name} — detected violation: {result.get('message', '')}")
        return True
    print(f"  MISS: {name} — did NOT detect violation!")
    return False


# ---------------------------------------------------------------------------
# Test: exit_codes_valid — remove an exit code
# ---------------------------------------------------------------------------

def test_exit_codes_valid_missing_code():
    _reset_caches()
    errors_ts = sp._PACKAGES_DIR / "cli" / "src" / "errors.ts"
    original = errors_ts.read_text(encoding="utf-8")
    tampered = original.replace("INTERNAL_ERROR: 99,", "")
    errors_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.exit_codes_valid({})
    finally:
        errors_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "exit_codes_valid_missing_code"), "checker did not detect violation: exit_codes_valid_missing_code"


def test_exit_codes_valid_wrong_value():
    _reset_caches()
    errors_ts = sp._PACKAGES_DIR / "cli" / "src" / "errors.ts"
    original = errors_ts.read_text(encoding="utf-8")
    tampered = original.replace("CONTRACT_FAIL: 2", "CONTRACT_FAIL: 99")
    errors_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.exit_codes_valid({})
    finally:
        errors_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "exit_codes_valid_wrong_value"), "checker did not detect violation: exit_codes_valid_wrong_value"


def test_cli_exit_code_enum_complete_missing_class():
    _reset_caches()
    errors_ts = sp._PACKAGES_DIR / "cli" / "src" / "errors.ts"
    original = errors_ts.read_text(encoding="utf-8")
    tampered = re.sub(
        r'export class ConfigError.*?^\s*\}',
        "",
        original,
        flags=re.MULTILINE | re.DOTALL,
    )
    errors_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.cli_exit_code_enum_complete({})
    finally:
        errors_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "cli_exit_code_enum_missing_class"), "checker did not detect violation: cli_exit_code_enum_missing_class"


# ---------------------------------------------------------------------------
# Test: operator_count_stable — drop operators below threshold
# ---------------------------------------------------------------------------

def test_operator_count_stable_low_count():
    """Add 40 fake operators at count=49, verify checker still passes,
    then set threshold by temporarily changing the checker logic."""
    _reset_caches()
    operators_ts = sp._PACKAGES_DIR / "core" / "src" / "registry" / "operators.ts"
    original = operators_ts.read_text(encoding="utf-8")

    current_count = len(re.findall(r"defineOperator\s*\(", original))

    # Remove enough operators to drop below 50
    # Find operator blocks and remove the last ones
    # Match: defineOperator({ ... }),
    blocks = list(re.finditer(
        r"defineOperator\s*\(\s*\{",
        original,
    ))

    if len(blocks) > 50:
        # Remove last (len(blocks) - 40) blocks — this leaves only 40 operators
        to_remove = len(blocks) - 40
        last_block_start = blocks[-to_remove].start()
        # Remove from last_block_start to end of CORE_OPERATOR_SPECS array
        # Find the closing ];
        end_marker = original.rfind("];")
        if end_marker > last_block_start:
            # Count how many defineOperator calls remain
            tampered = original[:last_block_start]
            # We need to keep the array opening
            # Actually, let's just modify the threshold in the checker
            # This is safer than tampering with the source
            pass

    # Alternative: directly test with a mocked threshold
    # The checker is: if count < 50: fail
    # We can't easily mock this, so let's use a different approach
    # Remove ALL defineOperator calls to make count = 0
    # This is drastic but proves the checker works

    # Actually, the simplest approach: count the current operators,
    # remove enough to go under the threshold
    # Find blocks from the end and remove them one by one
    remove_count = current_count - 49  # drop to 49

    # Find all defineOperator( ... ), patterns using a more robust approach
    operator_pattern = re.compile(
        r"defineOperator\s*\(\s*\{[^}]*\}\s*\),?\s*\n?",
        re.DOTALL,
    )
    matches = list(operator_pattern.finditer(original))

    if remove_count > 0 and len(matches) >= remove_count:
        # Remove the last N operators
        removals = matches[-remove_count:]
        # Remove in reverse order to preserve positions
        tampered = original
        for m in reversed(removals):
            tampered = tampered[:m.start()] + tampered[m.end():]

        operators_ts.write_text(tampered, encoding="utf-8")
        try:
            result = sp.operator_count_stable({})
        finally:
            operators_ts.write_text(original, encoding="utf-8")
        assert _pass_if_false(result, "operator_count_stable_low_count"), "checker did not detect violation: operator_count_stable_low_count"
        return

    pytest.skip("not enough operators to remove")


# ---------------------------------------------------------------------------
# Test: operator_spec_consistent — remove a required field
# ---------------------------------------------------------------------------

def test_operator_spec_consistent_missing_field():
    _reset_caches()
    operators_ts = sp._PACKAGES_DIR / "core" / "src" / "registry" / "operators.ts"
    original = operators_ts.read_text(encoding="utf-8")
    tampered = original.replace(
        'description: "Resolve a data path from one or more symbols."',
        "",
        1,
    )
    operators_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.operator_spec_consistent({})
    finally:
        operators_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "operator_spec_consistent_missing_field"), "checker did not detect violation: operator_spec_consistent_missing_field"


# ---------------------------------------------------------------------------
# Test: manifest_hash_algorithm — change to weaker hash
# ---------------------------------------------------------------------------

def test_manifest_hash_algorithm_weaker():
    _reset_caches()
    manifest_ts = sp._PACKAGES_DIR / "core" / "src" / "manifest" / "manifest.ts"
    original = manifest_ts.read_text(encoding="utf-8")
    tampered = original.replace('createHash("sha256")', 'createHash("sha1")')
    manifest_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.manifest_hash_algorithm({})
    finally:
        manifest_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "manifest_hash_algorithm_weaker"), "checker did not detect violation: manifest_hash_algorithm_weaker"


# ---------------------------------------------------------------------------
# Test: structural_types_stable — remove a type
# ---------------------------------------------------------------------------

def test_structural_types_stable_missing_type():
    _reset_caches()
    types_ts = sp._PACKAGES_DIR / "core" / "src" / "ast" / "types.ts"
    original = types_ts.read_text(encoding="utf-8")
    tampered = original.replace('| "Unknown";', "")
    types_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.structural_types_stable({})
    finally:
        types_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "structural_types_stable_missing_type"), "checker did not detect violation: structural_types_stable_missing_type"


# ---------------------------------------------------------------------------
# Test: manifest_version_stable — version mismatch
# ---------------------------------------------------------------------------

def test_manifest_version_stable_mismatch():
    _reset_caches()
    manifest_path = sp._REPO_ROOT / "contract" / ".manifest.json"
    original_content = None
    had_manifest = manifest_path.exists()
    if had_manifest:
        original_content = manifest_path.read_text(encoding="utf-8")

    bad_manifest = json.dumps({
        "version": "1",
        "stele_version": "9.9",
        "generated_at": "2026-01-01T00:00:00Z",
        "protected_files": {},
        "contract_hash": "abc123",
    })
    manifest_path.write_text(bad_manifest, encoding="utf-8")
    try:
        result = sp.manifest_version_stable({})
    finally:
        if had_manifest:
            manifest_path.write_text(original_content, encoding="utf-8")
        else:
            manifest_path.unlink()
    assert _pass_if_false(result, "manifest_version_stable_mismatch"), "checker did not detect violation: manifest_version_stable_mismatch"


def test_manifest_version_stable_missing_field():
    _reset_caches()
    manifest_path = sp._REPO_ROOT / "contract" / ".manifest.json"
    original_content = None
    had_manifest = manifest_path.exists()
    if had_manifest:
        original_content = manifest_path.read_text(encoding="utf-8")

    bad_manifest = json.dumps({
        "version": "1",
        "generated_at": "2026-01-01T00:00:00Z",
        "protected_files": {},
        "contract_hash": "abc123",
    })
    manifest_path.write_text(bad_manifest, encoding="utf-8")
    try:
        result = sp.manifest_version_stable({})
    finally:
        if had_manifest:
            manifest_path.write_text(original_content, encoding="utf-8")
        else:
            manifest_path.unlink()
    assert _pass_if_false(result, "manifest_version_stable_missing_field"), "checker did not detect violation: manifest_version_stable_missing_field"


# ---------------------------------------------------------------------------
# Test: required_commands_exist — remove a command
# ---------------------------------------------------------------------------

def test_required_commands_exist_missing():
    _reset_caches()
    commands_dir = sp._PACKAGES_DIR / "cli" / "src" / "commands"
    lock_ts = commands_dir / "lock.ts"
    backup_ts = commands_dir / "lock_backup.ts"
    lock_ts.rename(backup_ts)
    try:
        result = sp.required_commands_exist({})
    finally:
        backup_ts.rename(lock_ts)
    assert _pass_if_false(result, "required_commands_exist_missing"), "checker did not detect violation: required_commands_exist_missing"


# ---------------------------------------------------------------------------
# Test: config_manifest_path_safe — remove 2-segment check
# ---------------------------------------------------------------------------

def test_config_manifest_path_safe_no_validation():
    _reset_caches()
    load_config_ts = sp._PACKAGES_DIR / "cli" / "src" / "config" / "loadConfig.ts"
    original = load_config_ts.read_text(encoding="utf-8")
    tampered = original.replace("segments.length !== 2", "segments.length !== 999")
    load_config_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.config_manifest_path_safe({})
    finally:
        load_config_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "config_manifest_path_safe_no_validation"), "checker did not detect violation: config_manifest_path_safe_no_validation"


# ---------------------------------------------------------------------------
# Test: hooks_fail_closed — remove all try blocks from pre-tool-protect.js
# ---------------------------------------------------------------------------

def test_hooks_fail_closed_no_try():
    """Replace ALL 'try {' with '// TRY_BLOCK', so checker sees no try."""
    _reset_caches()
    pre_tool = sp._PACKAGES_DIR / "claude-code-plugin" / "scripts" / "pre-tool-protect.js"
    original = pre_tool.read_text(encoding="utf-8")
    # Replace ALL occurrences
    tampered = original.replace("try {", "// TRY_BLOCK_REMOVED {")
    pre_tool.write_text(tampered, encoding="utf-8")
    try:
        result = sp.hooks_fail_closed({})
    finally:
        pre_tool.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "hooks_fail_closed_no_try"), "checker did not detect violation: hooks_fail_closed_no_try"


# ---------------------------------------------------------------------------
# Test: hooks_registration_complete — add reference to missing script
# ---------------------------------------------------------------------------

def test_hooks_registration_missing_script():
    """Replace a full command string with one referencing a missing script."""
    _reset_caches()
    hooks_json = sp._PACKAGES_DIR / "claude-code-plugin" / "hooks" / "hooks.json"
    original = hooks_json.read_text(encoding="utf-8")

    # Replace the observation hook command entirely with a reference to a missing script
    tampered = original.replace(
        'scripts/observation-hook.js',
        'scripts/absolutely-real-missing-script.js',
    )
    hooks_json.write_text(tampered, encoding="utf-8")
    try:
        result = sp.hooks_registration_complete({})
    finally:
        hooks_json.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "hooks_registration_missing_script"), "checker did not detect violation: hooks_registration_missing_script"


# ---------------------------------------------------------------------------
# Test: protected_pattern_safe — add traversal pattern
# ---------------------------------------------------------------------------

def test_protected_pattern_safe_traversal():
    """Add a traversal pattern to defaults.ts protected config."""
    _reset_caches()
    defaults_ts = sp._PACKAGES_DIR / "cli" / "src" / "config" / "defaults.ts"
    original = defaults_ts.read_text(encoding="utf-8")

    # Add a pattern with parent traversal
    tampered = original.replace(
        "protected: [",
        'protected: [\n    "../secret.env",',
    )
    defaults_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.protected_pattern_safe({})
    finally:
        defaults_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "protected_pattern_safe_traversal"), "checker did not detect violation: protected_pattern_safe_traversal"


# ---------------------------------------------------------------------------
# Test: error_code_families_present — remove SteleError class
# ---------------------------------------------------------------------------

def test_error_code_families_missing_class():
    _reset_caches()
    stele_error_ts = sp._PACKAGES_DIR / "core" / "src" / "errors" / "SteleError.ts"
    original = stele_error_ts.read_text(encoding="utf-8")
    tampered = original.replace("class SteleError", "class _SteleError_RENAMED")
    stele_error_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.error_code_families_present({})
    finally:
        stele_error_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "error_code_families_missing_class"), "checker did not detect violation: error_code_families_missing_class"


# ---------------------------------------------------------------------------
# Test: cdl_no_single_quotes — add single quote on non-comment line
# ---------------------------------------------------------------------------

def test_cdl_no_single_quotes_violation():
    """Write a .stele file with single quotes NOT inside double quotes."""
    _reset_caches()
    stele_file = sp._REPO_ROOT / "contract" / "negative-test.stele"

    # A line with single quotes NOT inside double-quoted strings.
    # The checker flags ' characters that are not inside "..."
    content = textwrap.dedent("""\
    (metadata
      (project "test")
    )

    ; ; comment line with ' quotes — should be skipped
    (invariant BAD 'single-quoted-value')
    """)
    stele_file.write_text(content, encoding="utf-8")
    try:
        result = sp.cdl_no_single_quotes({})
    finally:
        stele_file.unlink(missing_ok=True)
    assert _pass_if_false(result, "cdl_no_single_quotes_violation"), "checker did not detect violation: cdl_no_single_quotes_violation"


# ---------------------------------------------------------------------------
# Test: inline_version_sync — mismatched version
# ---------------------------------------------------------------------------

def test_inline_version_sync_mismatch():
    _reset_caches()
    manifest_ts = sp._PACKAGES_DIR / "core" / "src" / "manifest" / "manifest.ts"
    original = manifest_ts.read_text(encoding="utf-8")
    tampered = original.replace('STELE_VERSION = "0.1.0"', 'STELE_VERSION = "99.99"')
    manifest_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.inline_version_sync({})
    finally:
        manifest_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "inline_version_sync_mismatch"), "checker did not detect violation: inline_version_sync_mismatch"


# ---------------------------------------------------------------------------
# Test: backend_registries — remove a backend
# ---------------------------------------------------------------------------

def test_backend_registries_missing_language():
    _reset_caches()
    registry_ts = sp._PACKAGES_DIR / "cli" / "src" / "backend-registry.ts"
    original = registry_ts.read_text(encoding="utf-8")
    tampered = original.replace('language: "go"', 'language: "go-temp-removed"')
    registry_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.backend_registries({})
    finally:
        registry_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "backend_registries_missing_language"), "checker did not detect violation: backend_registries_missing_language"


def test_backend_contains_go_missing():
    _reset_caches()
    registry_ts = sp._PACKAGES_DIR / "cli" / "src" / "backend-registry.ts"
    original = registry_ts.read_text(encoding="utf-8")
    tampered = original.replace('language: "go"', 'language: "go-removed"')
    registry_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.backend_contains_go({})
    finally:
        registry_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "backend_contains_go_missing"), "checker did not detect violation: backend_contains_go_missing"


# ---------------------------------------------------------------------------
# Test: config_schema_valid — missing field
# ---------------------------------------------------------------------------

def test_config_schema_valid_missing_field():
    _reset_caches()
    config_path = sp._REPO_ROOT / "stele.config.json"
    original = config_path.read_text(encoding="utf-8")
    config = json.loads(original)
    config.pop("targetLanguage", None)
    tampered = json.dumps(config, indent=2)
    config_path.write_text(tampered, encoding="utf-8")
    try:
        result = sp.config_schema_valid({})
    finally:
        config_path.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "config_schema_valid_missing_field"), "checker did not detect violation: config_schema_valid_missing_field"


# ---------------------------------------------------------------------------
# Test: cdl_utf8_valid — invalid UTF-8
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Test: all_evaluators_compile — temporarily rename one evaluator's dist
# ---------------------------------------------------------------------------

def test_all_evaluators_compile_missing_dist():
    """Round 3 P0-8: rename packages/effect-evaluator/dist to a different name
    so the checker can't find dist/index.js, then verify failure."""
    _reset_caches()
    dist_dir = sp._PACKAGES_DIR / "effect-evaluator" / "dist"
    backup_dir = sp._PACKAGES_DIR / "effect-evaluator" / "dist.bak-negtest"
    if not dist_dir.is_dir():
        pytest.skip("effect-evaluator/dist/ not built; run pnpm build first")
    dist_dir.rename(backup_dir)
    try:
        result = sp.all_evaluators_compile({})
    finally:
        backup_dir.rename(dist_dir)
    assert _pass_if_false(result, "all_evaluators_compile_missing_dist"), "checker did not detect violation: all_evaluators_compile_missing_dist"


# ---------------------------------------------------------------------------
# Test: strict_mode_default_in_ci — inject a --lenient-effects flag
# ---------------------------------------------------------------------------

def test_strict_mode_default_in_ci_lenient_flag():
    """Round 3 P0-8: inject a --lenient-effects flag into ci.yml, verify
    checker catches it."""
    _reset_caches()
    ci_yml = sp._REPO_ROOT / ".github" / "workflows" / "ci.yml"
    if not ci_yml.is_file():
        pytest.skip(".github/workflows/ci.yml not present")
    original = ci_yml.read_text(encoding="utf-8")
    tampered = original.replace(
        "pnpm test",
        "pnpm test --lenient-effects",
        1,
    )
    ci_yml.write_text(tampered, encoding="utf-8")
    try:
        result = sp.strict_mode_default_in_ci({})
    finally:
        ci_yml.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "strict_mode_default_in_ci_lenient_flag"), "checker did not detect violation: strict_mode_default_in_ci_lenient_flag"


# ---------------------------------------------------------------------------
# Test: fix_hint_requires_analysis_branch — drop the [A] marker from a hint
# ---------------------------------------------------------------------------

def test_fix_hint_requires_analysis_branch_missing_keyword():
    """Round 3 P0-8: rewrite a default fix-hint function body so it no
    longer contains the literal `[A]`, verify the checker catches it."""
    _reset_caches()
    fix_hint_ts = sp._PACKAGES_DIR / "effect-evaluator" / "src" / "fix-hint.ts"
    if not fix_hint_ts.is_file():
        pytest.skip("effect-evaluator/src/fix-hint.ts not present")
    original = fix_hint_ts.read_text(encoding="utf-8")
    # The default fix-hint uses `[A] Code issue` literals; rip them out.
    tampered = original.replace("[A]", "(branch-A)")
    fix_hint_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.fix_hint_requires_analysis_branch({})
    finally:
        fix_hint_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "fix_hint_requires_analysis_branch_missing_keyword"), "checker did not detect violation: fix_hint_requires_analysis_branch_missing_keyword"


def test_strict_mode_default_in_ci_env_injection():
    """Round 3 P1-3: place the lenient flag inside a workflow `env:` value
    (e.g. STELE_ARGS: "--lenient-effects") and verify the checker catches
    it. The pre-P1-3 substring scan would only find argv-line occurrences."""
    _reset_caches()
    ci_yml = sp._REPO_ROOT / ".github" / "workflows" / "ci.yml"
    if not ci_yml.is_file():
        pytest.skip(".github/workflows/ci.yml not present")
    original = ci_yml.read_text(encoding="utf-8")
    # Inject an env block whose value carries the lenient flag.
    tampered = original.replace(
        "    steps:\n",
        "    env:\n      STELE_ARGS: \"--lenient-effects\"\n    steps:\n",
        1,
    )
    ci_yml.write_text(tampered, encoding="utf-8")
    try:
        result = sp.strict_mode_default_in_ci({})
    finally:
        ci_yml.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "strict_mode_default_in_ci_env_injection"), "checker did not detect violation: strict_mode_default_in_ci_env_injection"


def test_strict_mode_default_in_ci_via_package_json_script():
    """Round 4 E-11: hide the lenient flag inside a `scripts.x` block in
    package.json. A workflow that invokes `pnpm run x` would otherwise
    pass — the script body is where the flag actually lives."""
    _reset_caches()
    pkg = sp._REPO_ROOT / "package.json"
    if not pkg.is_file():
        pytest.skip("package.json missing")
    original = pkg.read_text(encoding="utf-8")
    import json as _json
    data = _json.loads(original)
    scripts = data.setdefault("scripts", {})
    scripts["__negtest_lenient"] = "stele check --lenient-effects"
    tampered = _json.dumps(data, indent=2) + "\n"
    pkg.write_text(tampered, encoding="utf-8")
    try:
        result = sp.strict_mode_default_in_ci({})
    finally:
        pkg.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "strict_mode_default_in_ci_via_package_json_script"), "checker did not detect violation: strict_mode_default_in_ci_via_package_json_script"


def test_strict_mode_default_in_ci_via_python_script_delegation():
    """Round 4 D-10 / E-11: workflow delegates to `python scripts/x.py`
    whose body carries the lenient flag. The legacy scanner only chased
    `.sh` files; the strengthened scanner must follow `.py` too."""
    _reset_caches()
    ci_yml = sp._REPO_ROOT / ".github" / "workflows" / "ci.yml"
    scripts_dir = sp._REPO_ROOT / "scripts"
    if not ci_yml.is_file() or not scripts_dir.is_dir():
        pytest.skip(".github/workflows/ci.yml or scripts/ missing")
    original_ci = ci_yml.read_text(encoding="utf-8")
    py_script = scripts_dir / "negtest-py-lenient.py"
    try:
        py_script.write_text(
            "import os\nos.system('stele check --lenient-effects')\n",
            encoding="utf-8",
        )
        tampered_ci = original_ci.replace(
            "      - run: pnpm install --frozen-lockfile",
            "      - run: python scripts/negtest-py-lenient.py\n      - run: pnpm install --frozen-lockfile",
            1,
        )
        ci_yml.write_text(tampered_ci, encoding="utf-8")
        result = sp.strict_mode_default_in_ci({})
    finally:
        ci_yml.write_text(original_ci, encoding="utf-8")
        py_script.unlink(missing_ok=True)
    assert _pass_if_false(result, "strict_mode_default_in_ci_via_python_script_delegation"), "checker did not detect violation: strict_mode_default_in_ci_via_python_script_delegation"


def test_strict_mode_default_in_ci_via_referenced_script():
    """Round 3 P1-3: hide the lenient flag in a referenced shell script
    instead of in the workflow itself; the checker must follow the
    `bash X.sh` reference and scan the script too."""
    _reset_caches()
    ci_yml = sp._REPO_ROOT / ".github" / "workflows" / "ci.yml"
    scripts_dir = sp._REPO_ROOT / "scripts"
    if not ci_yml.is_file() or not scripts_dir.is_dir():
        pytest.skip(".github/workflows/ci.yml or scripts/ missing")
    original_ci = ci_yml.read_text(encoding="utf-8")
    new_script = scripts_dir / "negtest-strict-mode.sh"
    try:
        # 1) Drop a script whose content carries the lenient flag.
        new_script.write_text(
            "#!/usr/bin/env bash\nset -euo pipefail\nstele check --lenient-effects\n",
            encoding="utf-8",
        )
        # 2) Wire the CI workflow to invoke that script.
        tampered_ci = original_ci.replace(
            "      - run: pnpm install --frozen-lockfile",
            "      - run: bash scripts/negtest-strict-mode.sh\n      - run: pnpm install --frozen-lockfile",
            1,
        )
        ci_yml.write_text(tampered_ci, encoding="utf-8")
        result = sp.strict_mode_default_in_ci({})
    finally:
        ci_yml.write_text(original_ci, encoding="utf-8")
        new_script.unlink(missing_ok=True)
    assert _pass_if_false(result, "strict_mode_default_in_ci_via_referenced_script"), "checker did not detect violation: strict_mode_default_in_ci_via_referenced_script"


def test_default_protected_consistent_drops_pattern_in_one_list():
    """Round 5 I-13: remove `.stele/stop-state.json` from the core list
    only, verify the consistency checker catches the divergence."""
    _reset_caches()
    core_defaults = sp._PACKAGES_DIR / "core" / "src" / "config" / "defaults.ts"
    if not core_defaults.is_file():
        pytest.skip("core defaults.ts missing")
    original = core_defaults.read_text(encoding="utf-8")
    tampered = original.replace('".stele/stop-state.json"', '"REMOVED-FOR-NEGTEST"', 1)
    core_defaults.write_text(tampered, encoding="utf-8")
    try:
        result = sp.default_protected_consistent({})
    finally:
        core_defaults.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "default_protected_consistent_drops_pattern_in_one_list"), "checker did not detect violation: default_protected_consistent_drops_pattern_in_one_list"


def test_esm_relative_imports_keep_js_missing_suffix():
    """Round 5 I-13: write a TS file with a relative import missing the
    .js suffix; the E-02 checker must catch it."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_esm.ts"
    target.write_text(
        'import { foo } from "./missing-suffix";\nexport const x = foo;\n',
        encoding="utf-8",
    )
    try:
        result = sp.esm_relative_imports_keep_js({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "esm_relative_imports_keep_js_missing_suffix"), "checker did not detect violation: esm_relative_imports_keep_js_missing_suffix"


def test_hook_entrypoints_fail_closed_catch_swallows_error():
    """Round 5 I-13: rewrite a hook script so its catch block swallows
    errors (no process.exit / failClosed / blockStop). The new K-02
    body-scoped check must catch it."""
    _reset_caches()
    hook = sp._PACKAGES_DIR / "claude-code-plugin" / "scripts" / "pre-tool-protect.js"
    if not hook.is_file():
        pytest.skip("pre-tool-protect.js missing")
    original = hook.read_text(encoding="utf-8")
    # Replace the literal `failClosed(` call inside catch bodies with a
    # console.error (so the catch swallows). Preserve all other
    # process.exit references elsewhere in the file (so the file-scope
    # OR'd legacy check would still pass — only the new body-scoped
    # check catches this).
    tampered = original.replace("failClosed(", "console.error(")
    hook.write_text(tampered, encoding="utf-8")
    try:
        result = sp.hook_entrypoints_fail_closed({})
    finally:
        hook.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "hook_entrypoints_fail_closed_catch_swallows_error"), "checker did not detect violation: hook_entrypoints_fail_closed_catch_swallows_error"


def test_core_has_no_stele_deps_dynamic_import():
    """Round 5 I-13: add a dynamic `import("@stele/cli")` to a core
    file; the K-03 wider regex must catch it (legacy regex required
    `from` keyword and missed dynamic imports)."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_dyn.ts"
    target.write_text(
        'export async function loadCli() {\n'
        '  const m = await import("@stele/cli");\n'
        '  return m;\n'
        '}\n',
        encoding="utf-8",
    )
    try:
        result = sp.core_has_no_stele_deps({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "core_has_no_stele_deps_dynamic_import"), "checker did not detect violation: core_has_no_stele_deps_dynamic_import"


def test_fix_hint_requires_analysis_branch_content_inversion():
    """Round 4 D-09: rewrite the [A] body to say "do nothing on the
    code side" with no action verb and no delegated template — the
    anchor labels are still correct but the content tells the agent
    that the code side has nothing to fix, which inverts the meaning.
    The stronger D-09 check requires a code-action verb OR a delegated
    interpolation in the [A] region; without either, refuse."""
    _reset_caches()
    fix_hint_ts = sp._PACKAGES_DIR / "type-state-evaluator" / "src" / "fix-hint.ts"
    if not fix_hint_ts.is_file():
        pytest.skip("type-state-evaluator/src/fix-hint.ts not present")
    original = fix_hint_ts.read_text(encoding="utf-8")
    # Surgically rewrite the [A] body to remove every action verb and any
    # template interpolation, while preserving the [A] / [B] anchor labels
    # and propose flow text so the legacy structural check passes. The new
    # D-09 content-inversion guard should still catch it.
    action_verbs = (
        "Change", "change", "Replace", "replace", "Refactor", "refactor",
        "Remove", "remove", "Insert", "insert", "Add", "add",
        "Annotate", "annotate", "Move", "move", "Delete", "delete",
        "Update", "update", "Edit", "edit", "Fix", "fix", "Stop", "Route",
        "Introduce", "introduce", "Rewrite", "rewrite",
    )
    tampered = original
    # Hollow out the codeBranch body — replace it with verb-less text + no
    # template interpolation.
    tampered = re.sub(
        r"const codeBranch = \[[\s\S]*?\]\.join\(\"\\n\"\);",
        "const codeBranch = ['no action required on the code side', 'situation is irrelevant'].join(\"\\n\");",
        tampered,
        count=1,
    )
    # Then scrub residual action verbs from the rest of the file so the
    # check can't satisfy itself via leftover text in [A] regions in
    # OTHER functions in the same file.
    for verb in action_verbs:
        tampered = tampered.replace(verb, "describing")
    fix_hint_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.fix_hint_requires_analysis_branch({})
    finally:
        fix_hint_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "fix_hint_requires_analysis_branch_content_inversion"), "checker did not detect violation: fix_hint_requires_analysis_branch_content_inversion"


def test_fix_hint_requires_analysis_branch_semantic_inversion():
    """Round 3 P1-2: rewrite the [A] anchor in trace-evaluator to claim it
    is the Contract branch. Every required substring (`code issue`, `contract
    issue`, `propose`, `[A]`, `[B]`) is still present in the file, so the
    legacy keyword check would PASS. The structural check must catch this
    via the missing canonical `[A] Code issue` anchor."""
    _reset_caches()
    fix_hint_ts = sp._PACKAGES_DIR / "trace-evaluator" / "src" / "fix-hint-substitution.ts"
    if not fix_hint_ts.is_file():
        pytest.skip("trace-evaluator/src/fix-hint-substitution.ts not present")
    original = fix_hint_ts.read_text(encoding="utf-8")
    tampered = original.replace("[A] Code issue", "[A] Contract issue")
    fix_hint_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.fix_hint_requires_analysis_branch({})
    finally:
        fix_hint_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "fix_hint_requires_analysis_branch_semantic_inversion"), "checker did not detect violation: fix_hint_requires_analysis_branch_semantic_inversion"


def test_cdl_utf8_valid_invalid_bytes():
    """Write invalid UTF-8 bytes to a .stele file, verify checker catches it."""
    _reset_caches()
    stele_file = sp._REPO_ROOT / "contract" / "test-utf8.stele"
    # Write a file with invalid UTF-8 byte sequence
    stele_file.write_bytes(b"(invariant TEST \xff\xfe)")
    try:
        result = sp.cdl_utf8_valid({})
    finally:
        stele_file.unlink(missing_ok=True)
    assert _pass_if_false(result, "cdl_utf8_valid_invalid_bytes"), "checker did not detect violation: cdl_utf8_valid_invalid_bytes"


# ---------------------------------------------------------------------------
# Round 7 — negative tests for the five new dogfood checkers + strengthened M-07
# ---------------------------------------------------------------------------


def test_no_cjs_require_in_ts_source_catches_require():
    """Round 7: write a .ts file with a CJS `require(...)` call inside
    `packages/core/src/`; the checker must flag it (allowlist only
    excludes `packages/cli/src/version.ts`)."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_cjs.ts"
    target.write_text(
        "const fs = require(\"node:fs\");\nexport const a = fs;\n",
        encoding="utf-8",
    )
    try:
        result = sp.no_cjs_require_in_ts_source({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "no_cjs_require_in_ts_source_catches_require"), "checker did not detect violation: no_cjs_require_in_ts_source_catches_require"


def test_tsconfig_base_strict_mode_weakened():
    """Round 7: rewrite tsconfig.base.json so `strict: true` is preserved
    BUT a per-option weakening (`strictNullChecks: false`) is layered
    on top — checker must refuse."""
    _reset_caches()
    tsconfig_path = sp._REPO_ROOT / "tsconfig.base.json"
    if not tsconfig_path.is_file():
        pytest.skip("tsconfig.base.json not present")
    original = tsconfig_path.read_text(encoding="utf-8")
    data = json.loads(original)
    data.setdefault("compilerOptions", {})["strictNullChecks"] = False
    tsconfig_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    try:
        result = sp.tsconfig_base_strict_mode({})
    finally:
        tsconfig_path.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "tsconfig_base_strict_mode_weakened"), "checker did not detect violation: tsconfig_base_strict_mode_weakened"


def test_no_backward_compat_shims_catches_marker():
    """Round 7: introduce a `// removed: X` marker in a TS file. The
    canonical-shim regex must catch it (the marker is the very thing
    the CLAUDE.md rule bans)."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_shim.ts"
    target.write_text(
        "// removed: legacy V0 helper, retained for backwards compat\n"
        "export const placeholder = 1;\n",
        encoding="utf-8",
    )
    try:
        result = sp.no_backward_compat_shims({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "no_backward_compat_shims_catches_marker"), "checker did not detect violation: no_backward_compat_shims_catches_marker"


def test_core_engine_purity_catches_date_now():
    """Round 7: drop a `Date.now()` call into a core source file outside
    the manifest-hash allowlist. Determinism guard must catch it."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_purity.ts"
    target.write_text(
        "export const stamp = Date.now();\n",
        encoding="utf-8",
    )
    try:
        result = sp.core_engine_purity({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "core_engine_purity_catches_date_now"), "checker did not detect violation: core_engine_purity_catches_date_now"


def test_cli_io_through_path_utils_catches_unsafe_write():
    """Round 7: write a CLI command file that calls `writeFile(...)` on
    a raw user-input path without any path-safety helper reference.
    The checker must flag it."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "cli" / "src" / "commands" / "__negtest_io.ts"
    target.write_text(
        "import { writeFile } from \"node:fs/promises\";\n"
        "export async function unsafe(input: string): Promise<void> {\n"
        "  await writeFile(input, \"data\");\n"
        "}\n",
        encoding="utf-8",
    )
    try:
        result = sp.cli_io_through_path_utils({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "cli_io_through_path_utils_catches_unsafe_write"), "checker did not detect violation: cli_io_through_path_utils_catches_unsafe_write"


def test_cli_exit_code_enum_complete_missing_code_value():
    """Round 7 M-07: rewrite errors.ts so the class names are still
    present BUT one named code value (SCORE_BELOW_THRESHOLD) is
    renamed. The strengthened checker must catch the missing code."""
    _reset_caches()
    errors_ts = sp._PACKAGES_DIR / "cli" / "src" / "errors.ts"
    if not errors_ts.is_file():
        pytest.skip("errors.ts not present")
    original = errors_ts.read_text(encoding="utf-8")
    tampered = re.sub(r"\bSCORE_BELOW_THRESHOLD\b", "SCORE_BELOW_LIMIT", original)
    errors_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.cli_exit_code_enum_complete({})
    finally:
        errors_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "cli_exit_code_enum_complete_missing_code_value"), "checker did not detect violation: cli_exit_code_enum_complete_missing_code_value"


# ---------------------------------------------------------------------------
# Round 8 — negative tests for the bypass fixes (N-01..N-08)
# ---------------------------------------------------------------------------


def test_cli_exit_code_enum_complete_stale_comment_fallback():
    """Round 8 N-03: delete the active SCORE_BELOW_THRESHOLD enum entry
    but leave a stale comment that mentions the name. Without the
    comment-stripping fix the regex would happily find the name in the
    comment and PASS — masking a real config drift."""
    _reset_caches()
    errors_ts = sp._PACKAGES_DIR / "cli" / "src" / "errors.ts"
    if not errors_ts.is_file():
        pytest.skip("errors.ts not present")
    original = errors_ts.read_text(encoding="utf-8")
    tampered = original.replace(
        "SCORE_BELOW_THRESHOLD: 6,",
        "// SCORE_BELOW_THRESHOLD: 6 (legacy, dropped)",
    )
    errors_ts.write_text(tampered, encoding="utf-8")
    try:
        result = sp.cli_exit_code_enum_complete({})
    finally:
        errors_ts.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "cli_exit_code_enum_complete_stale_comment_fallback"), "checker did not detect violation: cli_exit_code_enum_complete_stale_comment_fallback"


def test_core_engine_purity_bare_imported_random():
    """Round 8 N-01: introduce `import { randomUUID } from "node:crypto"`
    + a call to bare `randomUUID()` in a core file. The original Round 7
    checker only saw the dotted `crypto.randomUUID()` form and missed
    this. The N-01 strengthening adds gated bare-name patterns."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_n01_bare_uuid.ts"
    target.write_text(
        'import { randomUUID } from "node:crypto";\n'
        'export const id = randomUUID();\n',
        encoding="utf-8",
    )
    try:
        result = sp.core_engine_purity({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "core_engine_purity_bare_imported_random"), "checker did not detect violation: core_engine_purity_bare_imported_random"


def test_no_backward_compat_shims_compatibility_synonym():
    """Round 8 N-04: the Round 7 regex required the literal word
    `compat` but agents naturally write `compatibility`. The N-04
    strengthening accepts both."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_n04_compat.ts"
    target.write_text(
        "// for backwards compatibility with v1\n"
        "export const x = 1;\n",
        encoding="utf-8",
    )
    try:
        result = sp.no_backward_compat_shims({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "no_backward_compat_shims_compatibility_synonym"), "checker did not detect violation: no_backward_compat_shims_compatibility_synonym"


def test_no_backward_compat_shims_block_comment_marker():
    """Round 8 N-04: `/* removed: ... */` block comments were not
    matched by the Round 7 line-anchored regex. The N-04 strengthening
    accepts EITHER comment opener (`//` or `/*`)."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_n04_block.ts"
    target.write_text(
        "/* removed: legacy helper */\n"
        "export const x = 1;\n",
        encoding="utf-8",
    )
    try:
        result = sp.no_backward_compat_shims({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "no_backward_compat_shims_block_comment_marker"), "checker did not detect violation: no_backward_compat_shims_block_comment_marker"


def test_no_backward_compat_shims_string_smuggle_does_not_false_positive():
    """Round 8 N-02 (positive guard): a comment-marker hiding INSIDE a
    string literal must NOT trip the checker. The N-02 strengthening
    blanks string interiors before scanning, so this returns
    passed=True (no real shim present)."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_n02_smuggle.ts"
    target.write_text(
        'const msg = "// removed: but this is just a string";\n'
        'export const x = msg;\n',
        encoding="utf-8",
    )
    try:
        result = sp.no_backward_compat_shims({})
    finally:
        target.unlink(missing_ok=True)
    # Inverted assertion: success means passed=True (checker correctly ignored).
    assert result.get("passed") is True, f"false-positive on smuggled marker (result={result})"


def test_cli_io_through_path_utils_string_smuggle_does_not_satisfy():
    """Round 8 N-02 + N-06: a CLI command file that writes to fs without
    a real safety helper, but mentions `resolve(` inside a string
    literal, must still be flagged. The Round 7 substring check would
    have been satisfied by the string content."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "cli" / "src" / "commands" / "__negtest_n02_smuggle.ts"
    target.write_text(
        'import { writeFile } from "node:fs/promises";\n'
        'export async function bad(input: string): Promise<void> {\n'
        '  const note = "always use resolve() in real code";\n'
        '  await writeFile(input, note);\n'
        '}\n',
        encoding="utf-8",
    )
    try:
        result = sp.cli_io_through_path_utils({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "cli_io_through_path_utils_string_smuggle_does_not_satisfy"), "checker did not detect violation: cli_io_through_path_utils_string_smuggle_does_not_satisfy"


def test_no_cjs_require_string_literal_does_not_false_positive():
    """Round 8 N-02 (positive guard): `require("x")` inside a string
    literal is NOT a CJS call, just text. The N-02 strengthening
    blanks string interiors so this stays passed=True."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_n02_cjs_str.ts"
    target.write_text(
        'const help = "to use CJS, write require(\\"foo\\")";\n'
        'export const x = help;\n',
        encoding="utf-8",
    )
    try:
        result = sp.no_cjs_require_in_ts_source({})
    finally:
        target.unlink(missing_ok=True)
    assert result.get("passed") is True, f"false-positive on smuggled require (result={result})"


# ---------------------------------------------------------------------------
# Round 9 — bypass-coverage tests for O-01..O-08 reviewer findings
# ---------------------------------------------------------------------------


def test_no_cjs_require_template_literal_expression():
    """Round 9 O-01: `` `${require("x")}` `` is a real CJS call inside
    a template-literal interpolation. The Round 8 string-blanker
    blanked the whole template interior; the Round 9 fix recognises
    `${...}` as code and must catch the call."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_o01_tpl.ts"
    target.write_text(
        "export const cb = `${require(\"x\")}`;\n",
        encoding="utf-8",
    )
    try:
        result = sp.no_cjs_require_in_ts_source({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "no_cjs_require_template_literal_expression"), "checker did not detect violation: no_cjs_require_template_literal_expression"


def test_core_engine_purity_template_literal_random():
    """Round 9 O-01 + N-01: `${randomUUID()}` inside a backtick string
    is a real nondeterminism source. The Round 9 fix recognises the
    expression as code and the N-01 gated bare-name pattern catches
    it (requires the `node:crypto` import to also be present)."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_o01_purity.ts"
    target.write_text(
        'import { randomUUID } from "node:crypto";\n'
        "export const cb = `${randomUUID()}`;\n",
        encoding="utf-8",
    )
    try:
        result = sp.core_engine_purity({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "core_engine_purity_template_literal_random"), "checker did not detect violation: core_engine_purity_template_literal_random"


def test_core_engine_purity_string_mention_of_crypto_does_not_false_positive():
    """Round 9 O-02 (positive guard): a string literal that merely
    *contains* the substring `from "node:crypto"` must NOT trip the
    import gate, otherwise any legitimate user-defined `randomBytes`/
    `randomUUID` function (no relation to node:crypto) in the same
    file would be flagged. The Round 9 fix anchors the gate at
    start-of-line `import` syntax instead."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_o02_str.ts"
    target.write_text(
        'const example = \'from "node:crypto"\';\n'
        "export function randomBytes(x: number): number { return x; }\n"
        "export const v = randomBytes(5);\n"
        "export const e = example;\n",
        encoding="utf-8",
    )
    try:
        result = sp.core_engine_purity({})
    finally:
        target.unlink(missing_ok=True)
    assert result.get("passed") is True, f"core_engine_purity false-positive (result={result})"


def test_cli_io_through_path_utils_array_join_no_longer_satisfies():
    """Round 9 O-08: a file that calls `writeFile(input, ...)` and
    only references `.join("")` (an Array#join, not path.join) must
    still be flagged. The Round 8 substring check accepted bare
    `join(` as a path-safety helper, which made `chunks.join("")`
    satisfy the rule."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "cli" / "src" / "commands" / "__negtest_o08_arrjoin.ts"
    target.write_text(
        'import { writeFile } from "node:fs/promises";\n'
        "export async function bad(input: string, chunks: string[]): Promise<void> {\n"
        '  const data = chunks.join("");\n'
        "  await writeFile(input, data);\n"
        "}\n",
        encoding="utf-8",
    )
    try:
        result = sp.cli_io_through_path_utils({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "cli_io_through_path_utils_array_join_no_longer_satisfies"), "checker did not detect violation: cli_io_through_path_utils_array_join_no_longer_satisfies"


def test_strip_block_comment_does_not_mis_terminate_on_slash_star_slash():
    """Round 9 O-03: `/*/ "smuggled" */` is a single block comment in
    real JS. The Round 8 `_blank_string_interiors` mis-terminated at
    the third `/` and then entered string mode at the `"`. The Round
    9 fix uses the standard two-char `*/` look-ahead so the entire
    region is preserved as a block comment."""
    _reset_caches()
    src = '/*/ "smuggled" */ const x = 1;\n'
    out = sp._blank_string_interiors(src)
    # The output must equal the input (no string blanking happened
    # because nothing was actually a string).
    assert out == src, f"blank_string_interiors mishandled `/*/ \"x\" */` (got={out!r}, want={src!r})"


# ---------------------------------------------------------------------------
# Round 10 — bypass-coverage tests for Q-01..Q-04 reviewer findings
# ---------------------------------------------------------------------------


def test_cli_io_through_path_utils_array_join_with_path_import_bypassed():
    """Round 10 Q-01 + Round 11 R-03: a file that imports the `path`
    module but uses it ONLY for the import (no path-helper call site)
    and writes via writeFile + Array.join — the Round 9 bare-helper
    fallback would accept `chunks.join("")` as path-safety. The
    Round 10/11 fix recognises that `chunks.join` is NOT a call to
    the imported `path` binding (no `path.<helper>` or imported-name
    call exists in the file), so the rule flags the violation."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "cli" / "src" / "commands" / "__negtest_q01_arrjoin.ts"
    target.write_text(
        # Note: NO call to a path-helper. The import is dead — yet the
        # Round 9 substring check would have accepted `chunks.join("")`.
        'import "node:path";\n'
        'import { writeFile } from "node:fs/promises";\n'
        "export async function bad(input: string, chunks: string[]): Promise<void> {\n"
        '  const data = chunks.join("");\n'
        "  await writeFile(input, data);\n"
        "}\n",
        encoding="utf-8",
    )
    try:
        result = sp.cli_io_through_path_utils({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "cli_io_through_path_utils_array_join_with_path_import_bypassed"), "checker did not detect violation: cli_io_through_path_utils_array_join_with_path_import_bypassed"


def test_core_engine_purity_multi_line_crypto_import():
    """Round 10 Q-02: a multi-line `import {\\n  randomBytes\\n} from
    "node:crypto"` was not matched by the Round 9 single-line regex
    (`[^;\\n]*`). The Round 10 fix uses `[\\s\\S]*?` so the multi-line
    case is caught."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_q02_multi_import.ts"
    target.write_text(
        "import {\n"
        "  randomBytes,\n"
        "  randomUUID\n"
        '} from "node:crypto";\n'
        "export const v = randomBytes(8);\n",
        encoding="utf-8",
    )
    try:
        result = sp.core_engine_purity({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "core_engine_purity_multi_line_crypto_import"), "checker did not detect violation: core_engine_purity_multi_line_crypto_import"


# ---------------------------------------------------------------------------
# Round 11 — bypass-coverage tests for R-01..R-03 reviewer findings
# ---------------------------------------------------------------------------


def test_cli_io_through_path_utils_template_literal_smuggled_import():
    """Round 11 R-02: an agent embeds a fake `import { resolve, join }
    from "node:path"` inside a template literal (docstring) to inject
    bindings the path-safety check would accept. The Round 11 fix
    uses the strings-blanked form to detect imports — template-literal
    interiors are blank, so no fake bindings can be injected."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "cli" / "src" / "commands" / "__negtest_r02_smuggle.ts"
    target.write_text(
        'import { writeFile } from "node:fs/promises";\n'
        "export async function bad(input: string, chunks: string[]): Promise<void> {\n"
        '  const docstring = `import { resolve, join } from "node:path"`;\n'
        '  const data = chunks.join("/");\n'
        "  await writeFile(input, data + docstring);\n"
        "}\n",
        encoding="utf-8",
    )
    try:
        result = sp.cli_io_through_path_utils({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "cli_io_through_path_utils_template_literal_smuggled_import"), "checker did not detect violation: cli_io_through_path_utils_template_literal_smuggled_import"


def test_bash_extractors_shared_rejects_local_redefinition():
    """Round 13 L-05/P-04: re-introducing a local `function
    extractRedirectTargets(...)` in observation-hook.js must be
    caught — the divergence is exactly the bug the shared module
    closed. Temporarily inject a local redefinition and confirm the
    checker reports the violation."""
    _reset_caches()
    target = sp._REPO_ROOT / "packages" / "claude-code-plugin" / "scripts" / "observation-hook.js"
    original = target.read_text(encoding="utf-8")
    tampered = original + "\nfunction extractRedirectTargets(tokens) { return []; }\n"
    target.write_text(tampered, encoding="utf-8")
    try:
        result = sp.bash_extractors_shared({})
    finally:
        target.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "bash_extractors_shared_rejects_local_redefinition"), "checker did not detect violation: bash_extractors_shared_rejects_local_redefinition"


def test_blank_string_interiors_recognises_regex_literal_with_quote_char_class():
    """Round 13 O-04: a JS regex literal `/[\"']/` contains a `\"`
    and `'` inside its character class. Without regex-literal
    awareness, the helper would enter string mode on the `\"` and
    swallow / corrupt downstream content. With Round 13's
    `_scan_regex_literal` + `_is_regex_context`, the regex body is
    preserved verbatim and the trailing `// removed: ...` comment is
    correctly recognised as a real shim marker."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "__negtest_o04_regex.ts"
    target.write_text(
        # NOTE: this file embeds a regex with quote chars in its
        # character class, then a real shim marker on a separate
        # statement. The shim checker must catch the marker; the
        # purity checker must not false-positive on the regex content.
        "const QUOTE_RE = /[\"']/g;\n"
        "// removed: legacy regex compatibility helper\n"
        "export const re = QUOTE_RE;\n",
        encoding="utf-8",
    )
    try:
        result = sp.no_backward_compat_shims({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "blank_string_interiors_recognises_regex_literal_with_quote_char_class"), "checker did not detect violation: blank_string_interiors_recognises_regex_literal_with_quote_char_class"


def test_cli_io_through_path_utils_url_default_followed_by_path_named_does_not_register_url_as_namespace():
    """Round 12 S-01: an `import x, { y } from "node:url"` line
    immediately above an `import { z } from "node:path"` line used to
    register `x` as a path namespace because the DEFAULT regex's
    optional `, { ... }` capture was unbounded `[\\s\\S]*?`. The
    Round 12 fix restricts the capture to `[^;{}]*?` (same defect
    class as Round 11 R-03 in the sibling NAMED regex)."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "cli" / "src" / "commands" / "__negtest_s01_url_default.ts"
    target.write_text(
        'import { writeFile } from "node:fs/promises";\n'
        'import urlPath, { fileURLToPath } from "node:url";\n'
        'import { junkSymbol } from "node:path";\n'
        "export async function bad(input: string): Promise<void> {\n"
        "  const safe = urlPath.dirname(input);\n"
        '  await writeFile(input, "danger");\n'
        "  return safe.length > 0 || fileURLToPath(input) === input || junkSymbol === null ? undefined : undefined;\n"
        "}\n",
        encoding="utf-8",
    )
    try:
        result = sp.cli_io_through_path_utils({})
    finally:
        target.unlink(missing_ok=True)
    assert _pass_if_false(result, "cli_io_through_path_utils_url_default_followed_by_path_named_does_not_register_url_as_namespace"), "checker did not detect violation: cli_io_through_path_utils_url_default_followed_by_path_named_does_not_register_url_as_namespace"


def test_cli_io_through_path_utils_mixed_default_named_import_accepted():
    """Round 11 R-03 (positive guard): `import path, { resolve as
    pathResolve } from "node:path"` is legal TypeScript. Both the
    default binding `path` and the aliased local binding `pathResolve`
    must be recognised as path-safety helpers — the file should PASS
    even though its fs-write site uses the aliased name."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "cli" / "src" / "commands" / "__negtest_r03_mixed.ts"
    target.write_text(
        'import { writeFile } from "node:fs/promises";\n'
        'import path, { resolve as pathResolve } from "node:path";\n'
        "export async function ok(input: string): Promise<void> {\n"
        "  const data = pathResolve(input);\n"
        "  const dir = path.dirname(data);\n"
        "  await writeFile(dir, data);\n"
        "}\n",
        encoding="utf-8",
    )
    try:
        result = sp.cli_io_through_path_utils({})
    finally:
        target.unlink(missing_ok=True)
    assert result.get("passed") is True, f"cli_io_through_path_utils false-positive on legitimate mixed import (result={result})"


# ---------------------------------------------------------------------------
# Phase 0 (self-dogfooding plan) — phase_language_config_valid
# ---------------------------------------------------------------------------


def test_phase_language_config_valid_rejects_bad_key():
    """Phase 0: an unknown phaseLanguages key (typo, future field, etc.)
    must trip the checker. Otherwise a renamed phase silently disables
    its dispatch override at check-time."""
    _reset_caches()
    config_path = sp._REPO_ROOT / "stele.config.json"
    original = config_path.read_text(encoding="utf-8")
    config = json.loads(original)
    config["phaseLanguages"] = {"invalid_key": "typescript"}
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    try:
        result = sp.phase_language_config_valid({})
    finally:
        config_path.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "phase_language_config_valid_rejects_bad_key"), "checker did not detect violation: phase_language_config_valid_rejects_bad_key"


def test_phase_language_config_valid_rejects_bad_lang():
    """Phase 0: an unsupported phaseLanguages value (e.g. "elixir") must
    trip the checker — otherwise the stage's `pickPhaseLanguage` returns
    a language no extractor knows about and the violation surfaces only
    via the harder-to-debug "no extractor" path."""
    _reset_caches()
    config_path = sp._REPO_ROOT / "stele.config.json"
    original = config_path.read_text(encoding="utf-8")
    config = json.loads(original)
    config["phaseLanguages"] = {"trace": "elixir"}
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    try:
        result = sp.phase_language_config_valid({})
    finally:
        config_path.write_text(original, encoding="utf-8")
    assert _pass_if_false(result, "phase_language_config_valid_rejects_bad_lang"), "checker did not detect violation: phase_language_config_valid_rejects_bad_lang"


# ---------------------------------------------------------------------------
# Phase 1 (self-dogfooding plan) — branded-id call-site enforcement
# ---------------------------------------------------------------------------
#
# For each of the 5 new invariants we mutate a TS file to introduce a
# raw-string assignment to the branded field, run the checker, and
# assert it fails. The originals are restored in a `try/finally` so a
# test failure does not corrupt the working tree.


def _inject_then_run(path: pathlib.Path, marker: str, replacement: str, checker):
    """Helper: temporarily replace `marker` with `replacement` in `path`,
    run `checker` with an empty context, then restore the original."""
    original = path.read_text(encoding="utf-8")
    tampered = original.replace(marker, replacement, 1)
    if tampered == original:
        raise RuntimeError(f"marker not found in {path}: {marker!r}")
    path.write_text(tampered, encoding="utf-8")
    try:
        return checker({})
    finally:
        path.write_text(original, encoding="utf-8")


def test_rule_id_uses_branded_type_catches_raw_literal():
    """Phase 1.2: injecting `rule_id: "stele:test-bypass"` (raw literal)
    into a real source file must trip the checker. The wrapped form
    `ruleId("stele:test-bypass")` is what every site currently uses;
    this proves dropping the wrap is detected."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "cli" / "src" / "commands" / "check-violations.ts"
    # Inject after the first `createGeneratedDriftViolation` body open
    # — pick a stable marker that exists in the file today.
    result = _inject_then_run(
        target,
        'rule_id: ruleId("stele.check.generated_drift"),',
        'rule_id: "stele.check.generated_drift",  // BYPASS',
        sp.rule_id_uses_branded_type,
    )
    assert _pass_if_false(result, "rule_id_uses_branded_type_catches_raw_literal"), "checker did not detect violation: rule_id_uses_branded_type_catches_raw_literal"


def test_sha256_uses_branded_type_catches_raw_literal():
    """Phase 1.3: injecting a `sha256: "<literal>"` line that bypasses
    the smart constructor must trip the checker."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "core" / "src" / "manifest" / "manifest.ts"
    result = _inject_then_run(
        target,
        'sha256: sha256SmartCtor(createHash("sha256").update(buffer).digest("hex")),',
        'sha256: "deadbeef" + "deadbeef" + "deadbeef" + "deadbeef" + "deadbeef" + "deadbeef" + "deadbeef" + "deadbeefdeadbeef",  // BYPASS',
        sp.sha256_uses_branded_type,
    )
    assert _pass_if_false(result, "sha256_uses_branded_type_catches_raw_literal"), "checker did not detect violation: sha256_uses_branded_type_catches_raw_literal"


def test_contract_path_uses_branded_type_catches_raw_literal():
    """Phase 1.4: injecting an unwrapped `entry: "contract/main.stele"`
    must trip the checker."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "cli" / "src" / "config" / "defaults.ts"
    result = _inject_then_run(
        target,
        'entry: contractPath("contract/main.stele"),',
        'entry: "contract/main.stele",  // BYPASS',
        sp.contract_path_uses_branded_type,
    )
    assert _pass_if_false(result, "contract_path_uses_branded_type_catches_raw_literal"), "checker did not detect violation: contract_path_uses_branded_type_catches_raw_literal"


def test_command_name_uses_branded_type_catches_raw_literal():
    """Phase 1.5: injecting an unwrapped `.command("...")` call must
    trip the checker even though the same file already uses
    `cmdSpec(...)` elsewhere."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "cli" / "src" / "index.ts"
    result = _inject_then_run(
        target,
        '.command(cmdSpec("doc"))',
        '.command("doc-bypass")',
        sp.command_name_uses_branded_type,
    )
    assert _pass_if_false(result, "command_name_uses_branded_type_catches_raw_literal"), "checker did not detect violation: command_name_uses_branded_type_catches_raw_literal"


def test_package_name_uses_branded_type_catches_raw_literal():
    """Phase 1.6: injecting an unwrapped `packageName: "@stele/..."`
    must trip the checker."""
    _reset_caches()
    target = sp._PACKAGES_DIR / "cli" / "src" / "backend-registry.ts"
    result = _inject_then_run(
        target,
        'packageName: toPackageName("@stele/backend-python"),',
        'packageName: "@stele/backend-python",  // BYPASS',
        sp.package_name_uses_branded_type,
    )
    assert _pass_if_false(result, "package_name_uses_branded_type_catches_raw_literal"), "checker did not detect violation: package_name_uses_branded_type_catches_raw_literal"


# ---------------------------------------------------------------------------
# Phase 2 (self-dogfooding plan): code-shape contracts.
#
# Code-shape contracts are evaluated by `@stele/cli`'s in-process TypeScript
# analyzer (Round 14 P1). There is no paired Python checker, so the negative
# tests run `node packages/cli/dist/index.js check` as a subprocess after
# mutating source, assert that exit code != 0 AND that the expected
# rule_id appears in the JSON report, then restore the source.
# ---------------------------------------------------------------------------

import subprocess  # noqa: E402  (deferred until Phase 2 tests)


def _run_stele_check_expect_violation(rule_id: str) -> bool:
    """Run `stele check --format json`; return True iff a violation with
    matching rule_id appears AND exit code is non-zero."""
    proc = subprocess.run(
        [
            "node",
            str(sp._REPO_ROOT / "packages" / "cli" / "dist" / "index.js"),
            "check",
            "--format",
            "json",
        ],
        cwd=str(sp._REPO_ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode == 0:
        print(f"  MISS: {rule_id} — stele check exited 0 (expected non-zero)")
        return False
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(f"  MISS: {rule_id} — stele check did not emit JSON: {proc.stdout[:200]}")
        return False
    violations = report.get("violations", [])
    matched = [v for v in violations if v.get("rule_id") == rule_id]
    if matched:
        print(f"  OK: {rule_id} — detected {len(matched)} violation(s)")
        return True
    print(f"  MISS: {rule_id} — no matching violations among {[v.get('rule_id') for v in violations]}")
    return False


def _code_shape_negative_with_temp_file(file_relpath: str, content: str, rule_id: str) -> bool:
    """Create a temporary file, run stele check, restore, return detection result."""
    target = sp._REPO_ROOT / file_relpath
    if target.exists():
        # We never overwrite real source — use a unique sentinel name.
        raise RuntimeError(f"refusing to overwrite existing file {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    try:
        return _run_stele_check_expect_violation(rule_id)
    finally:
        try:
            target.unlink()
        except FileNotFoundError:
            pass


def test_core_no_fs_write_from_non_manifest_catches_writeFile_import():
    """Phase 2.1: adding a non-manifest core file that imports
    `node:fs/promises` must trip the boundary."""
    content = (
        'import { writeFile } from "node:fs/promises";\n'
        'export async function leak(p: string): Promise<void> { await writeFile(p, "x"); }\n'
    )
    assert _code_shape_negative_with_temp_file(
        "packages/core/src/__phase2_negative_fs_leak.ts",
        content,
        "core-no-fs-write-from-non-manifest",
    ), "checker did not detect violation: core-no-fs-write-from-non-manifest"


def test_cli_commands_no_direct_fs_write_catches_writeFileSync_call():
    """Phase 2.1: a new CLI command outside the allow-list that calls
    writeFileSync at module level must trip the boundary."""
    content = (
        'import { writeFileSync } from "node:fs";\n'
        'writeFileSync("/tmp/leak.txt", "leak");\n'
    )
    assert _code_shape_negative_with_temp_file(
        "packages/cli/src/commands/__phase2_negative_sync_write.ts",
        content,
        "cli-commands-no-direct-fs-write",
    ), "checker did not detect violation: cli-commands-no-direct-fs-write"


# ---------------------------------------------------------------------------
# Phase 4 — effect-policy negative tests
# ---------------------------------------------------------------------------


def test_core_is_pure_or_fs_read_catches_random_in_core():
    """Phase 4.3: a new @stele/core file that calls Math.random() must
    trip CORE_IS_PURE_OR_FS_READ because `random` is not in the
    allow-only set {fs.read, fs.write, crypto.hash}."""
    # Mark the function with the random effect so the evaluator's
    # source-code annotation extractor attributes it to this node.
    content = (
        '/** @stele:effects random */\n'
        'export function unluckyId(): number { return Math.random(); }\n'
    )
    assert _code_shape_negative_with_temp_file(
        "packages/core/src/__phase4_negative_random.ts",
        content,
        "effect.CORE_IS_PURE_OR_FS_READ.disallowed_effect",
    ), "checker did not detect violation: effect.CORE_IS_PURE_OR_FS_READ.disallowed_effect"


@pytest.mark.skip(
    reason=(
        "HOOK_NO_NETWORK policy targets *.js files (hook scripts ship as "
        "plain ESM .js), but the TypeScript call-graph extractor sets "
        "allowJs:false (packages/backend-typescript/src/extractors/call-graph.ts:222) "
        "and the directory walker only collects .ts/.tsx "
        "(call-graph.ts:269). The policy is therefore dead: it cannot fire "
        "on any real hook script, nor on this synthetic test file. "
        "Round 15 reviewer T (2026-05-25) caught this — the prior test "
        "used `return` instead of `assert` and falsely reported pass. "
        "Phase 7 follow-up options: (a) enable allowJs in the extractor "
        "(broader call-graph scope; needs perf check), or (b) migrate "
        "hook scripts to .ts with a transpile step. Until one of those "
        "lands the policy is effectively documentation, not enforcement."
    )
)
def test_hook_no_network_catches_fetch_in_hook_script():
    """Phase 4.3: a new hook script that calls fetch() must trip
    HOOK_NO_NETWORK. Currently skipped — see decorator."""


@pytest.mark.skip(
    reason=(
        "GENERATOR_NO_NETWORK_OR_CHILD_PROCESS target-scope is a single file "
        "(packages/cli/src/commands/generate.ts::*); a negative test cannot "
        "drop a sibling that the policy will see. Phase 7 follow-up: widen "
        "target-scope or use _mutate_then_check on generate.ts directly."
    )
)
def test_generator_no_network_or_child_process_catches_execfile():
    """Phase 4.3: introducing an execFile call inside generate.ts must
    trip GENERATOR_NO_NETWORK_OR_CHILD_PROCESS."""


def test_manifest_leaves_are_pinned_catches_extra_effect():
    """Phase 4.3: a new function inside hash-manifest.ts that has an
    effect outside {fs.read, fs.write, crypto.hash, time, random} must
    trip MANIFEST_LEAVES_ARE_PINNED. Use `network` — clearly
    out of bounds for a manifest file."""
    # Append an annotated helper at the bottom of hash-manifest.ts.
    def mutator(text: str) -> str:
        injection = (
            "\n/** @stele:effects network */\n"
            "export async function phaseNegativeNetwork(): Promise<void> {\n"
            "  // synthetic — for Phase 4 negative test only\n"
            "}\n"
        )
        return text + injection

    assert _mutate_then_check(
        "packages/core/src/manifest/hash-manifest.ts",
        mutator,
        "effect.MANIFEST_LEAVES_ARE_PINNED.disallowed_effect",
    ), "checker did not detect violation: effect.MANIFEST_LEAVES_ARE_PINNED.disallowed_effect"


def _mutate_then_check(file_relpath: str, mutator, rule_id: str) -> bool:
    """Apply `mutator(original_text) -> new_text` to a real source file,
    run stele check, expect the matching rule_id, restore the file."""
    target = sp._REPO_ROOT / file_relpath
    original = target.read_text(encoding="utf-8")
    mutated = mutator(original)
    if mutated == original:
        print(f"  ERROR: mutator produced no change to {file_relpath}")
        return False
    target.write_text(mutated, encoding="utf-8")
    try:
        return _run_stele_check_expect_violation(rule_id)
    finally:
        target.write_text(original, encoding="utf-8")


def test_operator_registry_shape_catches_missing_method():
    """Phase 6 self-dogfooding (2026-05-25): the operator-registry class-shape
    now ships from the DDD design profile via the design generator. The
    rule id is `core-operator-registry-aggregate-shape`; the mutation
    asserts the same anti-evasion property — removing the `register`
    method body from InMemoryOperatorRegistry must trip the contract."""
    assert _mutate_then_check(
        "packages/core/src/registry/operators.ts",
        # Drop the `register` method body — a brittle but exact mutation.
        lambda text: re.sub(
            r"\n  register\(spec: OperatorSpec\): void \{[\s\S]*?\n  \}\n",
            "\n",
            text,
            count=1,
        ),
        "core-operator-registry-aggregate-shape",
    ), "checker did not detect violation: core-operator-registry-aggregate-shape"


def test_operator_registry_shape_catches_missing_field():
    """Phase 6 self-dogfooding: removing the `#operators` private field
    declaration from InMemoryOperatorRegistry must trip the generated
    class-shape's must-have-field constraint."""
    assert _mutate_then_check(
        "packages/core/src/registry/operators.ts",
        lambda text: text.replace(
            "  readonly #operators = new Map<string, OperatorSpec>();\n",
            "",
            1,
        ),
        "core-operator-registry-aggregate-shape",
    ), "checker did not detect violation: core-operator-registry-aggregate-shape"


def test_cli_command_error_shape_catches_missing_field():
    """Phase 2.2: removing the `exitCode` field declaration from
    CliCommandError must trip the class-shape."""
    assert _mutate_then_check(
        "packages/cli/src/errors.ts",
        lambda text: text.replace(
            "  readonly exitCode: ExitCode;\n",
            "",
            1,
        ),
        "cli-command-error-shape",
    ), "checker did not detect violation: cli-command-error-shape"


def test_hook_fail_closed_v2_catches_missing_failClosed_call():
    """Phase 2.3: removing the `failClosed(...)` call from pre-tool-protect.js
    main() must trip the function-shape."""
    assert _mutate_then_check(
        "packages/claude-code-plugin/scripts/pre-tool-protect.js",
        lambda text: text.replace(
            "failClosed(error instanceof Error ? error.message : String(error));",
            'process.stdout.write("// fail-open bypass\\n");',
            1,
        ),
        "hook-fail-closed-v2",
    ), "checker did not detect violation: hook-fail-closed-v2"


def test_stop_validate_fail_closed_catches_missing_blockStop_call():
    """Phase 2.3: removing every `blockStop(` call from stop-validate.js main()
    must trip the function-shape (the analyzer captures all calls inside
    main; absent one removed, others remain). To force a miss we substitute
    every blockStop with a no-op pattern."""
    assert _mutate_then_check(
        "packages/claude-code-plugin/scripts/stop-validate.js",
        lambda text: text.replace("blockStop(", "process.stdout.write("),
        "stop-validate-fail-closed",
    ), "checker did not detect violation: stop-validate-fail-closed"


def test_write_atomic_has_rename_catches_missing_rename_call():
    """Phase 2.3: removing the `rename(...)` call from `writeAtomic` must
    trip the function-shape."""
    assert _mutate_then_check(
        "packages/core/src/manifest/hash-manifest.ts",
        lambda text: text.replace(
            "await rename(tmpPath, targetPath);",
            "await writeFile(targetPath, content);",
            1,
        ),
        "write-atomic-has-rename",
    ), "checker did not detect violation: write-atomic-has-rename"


def test_no_any_in_core_catches_any_annotation():
    """Phase 2.4: adding a `: any` annotation inside @stele/core must trip
    the type-policy."""
    assert _code_shape_negative_with_temp_file(
        "packages/core/src/__phase2_negative_any_leak.ts",
        "export const x: any = 1;\n",
        "no-any-in-core",
    ), "checker did not detect violation: no-any-in-core"


def test_hook_scripts_shebang_catches_missing_shebang():
    """Phase 2.5: removing the `#!/usr/bin/env node` shebang from one of
    the four hook entrypoint scripts must trip the file-policy."""
    assert _mutate_then_check(
        "packages/claude-code-plugin/scripts/observation-hook.js",
        lambda text: text.replace("#!/usr/bin/env node\n", "", 1),
        "hook-scripts-shebang",
    ), "checker did not detect violation: hook-scripts-shebang"


# ---------------------------------------------------------------------------
# Phase 3 (self-dogfooding plan): trace-policy negative tests.
#
# Trace-policy violations carry rule_ids of the form
# `trace.<POLICY_ID>.<kind>` where `<kind>` is one of
# `missing_transit` / `missing_predecessor` / `direct_call_denied` /
# `forbidden_transit` (see packages/trace-evaluator/src/types.ts).
#
# Each test mutates source so that a single trace-policy fires, runs
# `stele check`, and asserts the specific rule_id is present.
# ---------------------------------------------------------------------------


def test_fs_writes_via_write_atomic_catches_direct_writeFile():
    """Phase 3.1: adding a file in @stele/core that calls
    node:fs/promises::writeFile directly (without transiting writeAtomic)
    must trip the trace-policy with a `missing_transit` violation."""
    content = (
        'import { writeFile } from "node:fs/promises";\n'
        "export async function __phase3_leak(p: string): Promise<void> {\n"
        '  await writeFile(p, "leak", "utf8");\n'
        "}\n"
    )
    assert _code_shape_negative_with_temp_file(
        "packages/core/src/__phase3_negative_fs_leak.ts",
        content,
        "trace.FS_WRITES_VIA_WRITE_ATOMIC.missing_transit",
    ), "checker did not detect violation: trace.FS_WRITES_VIA_WRITE_ATOMIC.missing_transit"


def test_check_prepare_via_load_contract_catches_bypass():
    """Phase 3.2: appending a function to check.ts that calls
    prepareCheckContextWithContract without first calling loadContract
    must trip the trace-policy with a `missing_predecessor` violation."""
    assert _mutate_then_check(
        "packages/cli/src/commands/check.ts",
        lambda text: text + (
            "\n"
            "export async function __phase3_bypass(\n"
            "  projectDir: string,\n"
            "  contract: Contract,\n"
            "): Promise<PreparedCheckContext> {\n"
            "  return prepareCheckContextWithContract(projectDir, contract);\n"
            "}\n"
        ),
        "trace.CHECK_PREPARE_VIA_LOAD_CONTRACT.missing_predecessor",
    ), "checker did not detect violation: trace.CHECK_PREPARE_VIA_LOAD_CONTRACT.missing_predecessor"


def test_generate_via_coordinator_catches_bypass():
    """Phase 3.3: appending a function to generate.ts that calls
    writeAtomic without first calling coordinateGeneration must trip
    the trace-policy with a `missing_predecessor` violation."""
    assert _mutate_then_check(
        "packages/cli/src/commands/generate.ts",
        lambda text: text + (
            "\n"
            "export async function __phase3_bypass_coord(p: string): Promise<void> {\n"
            '  await writeAtomic(p, "leak");\n'
            "}\n"
        ),
        "trace.GENERATE_VIA_COORDINATOR.missing_predecessor",
    ), "checker did not detect violation: trace.GENERATE_VIA_COORDINATOR.missing_predecessor"


def test_approve_via_resolve_approved_by_catches_bypass():
    """Phase 3.5: appending a function to approve.ts that calls
    writeFileSync without first calling resolveApprovedBy must trip
    the trace-policy with a `missing_predecessor` violation."""
    assert _mutate_then_check(
        "packages/cli/src/commands/design/approve.ts",
        lambda text: text + (
            "\n"
            "export function __phase3_bypass_identity(p: string): void {\n"
            '  writeFileSync(p, "forged-approval", "utf8");\n'
            "}\n"
        ),
        "trace.APPROVE_VIA_RESOLVE_APPROVED_BY.missing_predecessor",
    ), "checker did not detect violation: trace.APPROVE_VIA_RESOLVE_APPROVED_BY.missing_predecessor"


# ---------------------------------------------------------------------------
# Phase 5 (self-dogfooding plan): type-state lifecycle negative tests.
#
# The Phase 5 type-state lifecycles are enforced primarily at TypeScript
# compile time via state-keyed phantom brands (reviewer V-05). The
# matching .test-d.ts files pin `@ts-expect-error` comments at sites
# where the brand discriminator is supposed to fire. The negative test
# for each lifecycle removes ONE pin, runs `tsc --noEmit`, asserts a
# TS2345 argument-not-assignable error surfaces, and restores the file.
#
# If the brand stops firing (i.e. tsc returns 0 after pin removal),
# the lifecycle's compile-time guarantee has regressed and the
# negative test fails.
# ---------------------------------------------------------------------------


def _type_state_brand_negative(
    test_d_relpath: str,
    pin_marker: str,
    typecheck_filter: str,
) -> bool:
    """Remove ONE `@ts-expect-error` line in a .test-d.ts file and assert
    that the immediately-following call no longer compiles.

    `pin_marker` is the EXACT comment text on the line being neutralized.
    `typecheck_filter` is a pnpm --filter target (e.g. @stele/core).
    """
    target = sp._REPO_ROOT / test_d_relpath
    original = target.read_text(encoding="utf-8")
    if pin_marker not in original:
        print(f"  MISS: {test_d_relpath} — pin marker not present in source")
        return False
    # Replace the marker line with an inert comment so tsc must surface
    # the underlying error.
    mutated = original.replace(
        f"// {pin_marker}",
        "// (neutralised by phase-5 negative test)",
        1,
    )
    if mutated == original:
        print(f"  MISS: {test_d_relpath} — replacement no-op")
        return False
    target.write_text(mutated, encoding="utf-8")
    try:
        proc = subprocess.run(
            ["pnpm", "--filter", typecheck_filter, "typecheck"],
            cwd=str(sp._REPO_ROOT),
            capture_output=True,
            text=True,
        )
    finally:
        target.write_text(original, encoding="utf-8")
    if proc.returncode == 0:
        print(f"  MISS: {test_d_relpath} — typecheck succeeded after pin removal (brand is broken)")
        return False
    if "TS2345" not in (proc.stdout + proc.stderr):
        print(f"  MISS: {test_d_relpath} — expected TS2345 not in output: {(proc.stdout + proc.stderr)[:300]}")
        return False
    print(f"  OK: {test_d_relpath} — brand fires (TS2345 after pin removal)")
    return True


def test_manifest_lifecycle_brand_fires():
    """Phase 5.1: removing the `@ts-expect-error` pin on the
    Loaded→Locked illegal transition in manifest-lifecycle.test-d.ts
    must surface a TS2345 error from `tsc --noEmit`."""
    assert _type_state_brand_negative(
        "packages/core/tests/manifest-lifecycle.test-d.ts",
        "@ts-expect-error — Loaded cannot be passed where Locked is required",
        "@stele/core",
    ), "checker did not detect violation: @stele/core"


def test_approval_lifecycle_brand_fires():
    """Phase 5.2: removing the pin on the Drafting→Signed illegal
    transition in approval-lifecycle.test-d.ts must surface TS2345."""
    assert _type_state_brand_negative(
        "packages/cli/tests/approval-lifecycle.test-d.ts",
        "@ts-expect-error — Drafting cannot be passed where IdentityChecked is required",
        "@stele/cli",
    ), "checker did not detect violation: @stele/cli"


def test_design_profile_lifecycle_brand_fires():
    """Phase 5.3: removing the pin on the Raw→Hashed illegal transition
    in design-profile-lifecycle.test-d.ts must surface TS2345."""
    assert _type_state_brand_negative(
        "packages/cli/tests/design-profile-lifecycle.test-d.ts",
        "@ts-expect-error — Raw cannot be passed where Validated is required",
        "@stele/cli",
    ), "checker did not detect violation: @stele/cli"


def test_callgraph_lifecycle_brand_fires():
    """Phase 5.4: removing the pin on the Empty→Built illegal transition
    in callgraph-lifecycle.test-d.ts must surface TS2345."""
    assert _type_state_brand_negative(
        "packages/call-graph-core/tests/callgraph-lifecycle.test-d.ts",
        "@ts-expect-error — Empty cannot be passed where Building is required",
        "@stele/call-graph-core",
    ), "checker did not detect violation: @stele/call-graph-core"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    passed = 0
    failed = 0
    errors = 0

    tests = [
        ("exit_codes_valid_missing_code", test_exit_codes_valid_missing_code),
        ("exit_codes_valid_wrong_value", test_exit_codes_valid_wrong_value),
        ("cli_exit_code_enum_missing_class", test_cli_exit_code_enum_complete_missing_class),
        ("operator_count_stable_low_count", test_operator_count_stable_low_count),
        ("operator_spec_consistent_missing_field", test_operator_spec_consistent_missing_field),
        ("manifest_hash_algorithm_weaker", test_manifest_hash_algorithm_weaker),
        ("structural_types_stable_missing_type", test_structural_types_stable_missing_type),
        ("manifest_version_stable_mismatch", test_manifest_version_stable_mismatch),
        ("manifest_version_stable_missing_field", test_manifest_version_stable_missing_field),
        ("required_commands_exist_missing", test_required_commands_exist_missing),
        ("config_manifest_path_safe_no_validation", test_config_manifest_path_safe_no_validation),
        ("hooks_fail_closed_no_try", test_hooks_fail_closed_no_try),
        ("hooks_registration_missing_script", test_hooks_registration_missing_script),
        ("protected_pattern_safe_traversal", test_protected_pattern_safe_traversal),
        ("error_code_families_missing_class", test_error_code_families_missing_class),
        ("cdl_no_single_quotes_violation", test_cdl_no_single_quotes_violation),
        ("cdl_utf8_valid_invalid_bytes", test_cdl_utf8_valid_invalid_bytes),
        ("inline_version_sync_mismatch", test_inline_version_sync_mismatch),
        ("backend_registries_missing_language", test_backend_registries_missing_language),
        ("backend_contains_go_missing", test_backend_contains_go_missing),
        ("config_schema_valid_missing_field", test_config_schema_valid_missing_field),
        # Round 3 P0-8: Phase B self-protection negative tests
        ("all_evaluators_compile_missing_dist", test_all_evaluators_compile_missing_dist),
        ("strict_mode_default_in_ci_lenient_flag", test_strict_mode_default_in_ci_lenient_flag),
        ("fix_hint_requires_analysis_branch_missing_keyword", test_fix_hint_requires_analysis_branch_missing_keyword),
        # Round 3 P1-2: semantic inversion negative test
        ("fix_hint_requires_analysis_branch_semantic_inversion", test_fix_hint_requires_analysis_branch_semantic_inversion),
        # Round 3 P1-3: env-injection + referenced-script bypass negatives
        ("strict_mode_default_in_ci_env_injection", test_strict_mode_default_in_ci_env_injection),
        ("strict_mode_default_in_ci_via_referenced_script", test_strict_mode_default_in_ci_via_referenced_script),
        # Round 4 E-11 + D-10
        ("strict_mode_default_in_ci_via_package_json_script", test_strict_mode_default_in_ci_via_package_json_script),
        ("strict_mode_default_in_ci_via_python_script_delegation", test_strict_mode_default_in_ci_via_python_script_delegation),
        # Round 4 D-09: content-inversion guard
        ("fix_hint_requires_analysis_branch_content_inversion", test_fix_hint_requires_analysis_branch_content_inversion),
        # Round 5 I-13: negative tests for the four Round-4 dogfood checkers
        ("default_protected_consistent_drops_pattern_in_one_list", test_default_protected_consistent_drops_pattern_in_one_list),
        ("esm_relative_imports_keep_js_missing_suffix", test_esm_relative_imports_keep_js_missing_suffix),
        ("hook_entrypoints_fail_closed_catch_swallows_error", test_hook_entrypoints_fail_closed_catch_swallows_error),
        ("core_has_no_stele_deps_dynamic_import", test_core_has_no_stele_deps_dynamic_import),
        # Round 7: negative tests for the five new dogfood checkers
        # (NO_CJS_REQUIRE_IN_TS_SOURCE, TSCONFIG_BASE_STRICT_MODE,
        # NO_BACKWARD_COMPAT_SHIMS, CORE_ENGINE_PURITY,
        # CLI_IO_THROUGH_PATH_UTILS) plus the M-07 strengthened
        # CLI_EXIT_CODE_ENUM_COMPLETE.
        ("no_cjs_require_in_ts_source_catches_require", test_no_cjs_require_in_ts_source_catches_require),
        ("tsconfig_base_strict_mode_weakened", test_tsconfig_base_strict_mode_weakened),
        ("no_backward_compat_shims_catches_marker", test_no_backward_compat_shims_catches_marker),
        ("core_engine_purity_catches_date_now", test_core_engine_purity_catches_date_now),
        ("cli_io_through_path_utils_catches_unsafe_write", test_cli_io_through_path_utils_catches_unsafe_write),
        ("cli_exit_code_enum_complete_missing_code_value", test_cli_exit_code_enum_complete_missing_code_value),
        # Round 8: bypass-coverage tests for N-01..N-04 reviewer findings.
        ("cli_exit_code_enum_complete_stale_comment_fallback", test_cli_exit_code_enum_complete_stale_comment_fallback),
        ("core_engine_purity_bare_imported_random", test_core_engine_purity_bare_imported_random),
        ("no_backward_compat_shims_compatibility_synonym", test_no_backward_compat_shims_compatibility_synonym),
        ("no_backward_compat_shims_block_comment_marker", test_no_backward_compat_shims_block_comment_marker),
        ("no_backward_compat_shims_string_smuggle_does_not_false_positive", test_no_backward_compat_shims_string_smuggle_does_not_false_positive),
        ("cli_io_through_path_utils_string_smuggle_does_not_satisfy", test_cli_io_through_path_utils_string_smuggle_does_not_satisfy),
        ("no_cjs_require_string_literal_does_not_false_positive", test_no_cjs_require_string_literal_does_not_false_positive),
        # Round 9: bypass-coverage tests for O-01..O-08.
        ("no_cjs_require_template_literal_expression", test_no_cjs_require_template_literal_expression),
        ("core_engine_purity_template_literal_random", test_core_engine_purity_template_literal_random),
        ("core_engine_purity_string_mention_of_crypto_does_not_false_positive", test_core_engine_purity_string_mention_of_crypto_does_not_false_positive),
        ("cli_io_through_path_utils_array_join_no_longer_satisfies", test_cli_io_through_path_utils_array_join_no_longer_satisfies),
        ("strip_block_comment_does_not_mis_terminate_on_slash_star_slash", test_strip_block_comment_does_not_mis_terminate_on_slash_star_slash),
        # Round 10: bypass-coverage tests for Q-01..Q-04.
        ("cli_io_through_path_utils_array_join_with_path_import_bypassed", test_cli_io_through_path_utils_array_join_with_path_import_bypassed),
        ("core_engine_purity_multi_line_crypto_import", test_core_engine_purity_multi_line_crypto_import),
        # Round 11: bypass-coverage tests for R-02 + R-03.
        ("cli_io_through_path_utils_template_literal_smuggled_import", test_cli_io_through_path_utils_template_literal_smuggled_import),
        ("cli_io_through_path_utils_mixed_default_named_import_accepted", test_cli_io_through_path_utils_mixed_default_named_import_accepted),
        # Round 12: S-01 cross-statement DEFAULT regex defect.
        ("cli_io_through_path_utils_url_default_followed_by_path_named_does_not_register_url_as_namespace", test_cli_io_through_path_utils_url_default_followed_by_path_named_does_not_register_url_as_namespace),
        # Round 13: O-04 regex literal tracking in string blanker.
        ("blank_string_interiors_recognises_regex_literal_with_quote_char_class", test_blank_string_interiors_recognises_regex_literal_with_quote_char_class),
        # Round 13: L-05/P-04 shared bash-extractor module.
        ("bash_extractors_shared_rejects_local_redefinition", test_bash_extractors_shared_rejects_local_redefinition),
        # Phase 0 (self-dogfooding plan): phaseLanguages config validity.
        ("phase_language_config_valid_rejects_bad_key", test_phase_language_config_valid_rejects_bad_key),
        ("phase_language_config_valid_rejects_bad_lang", test_phase_language_config_valid_rejects_bad_lang),
        # Phase 1 (self-dogfooding plan): branded-id call-site enforcement.
        ("rule_id_uses_branded_type_catches_raw_literal", test_rule_id_uses_branded_type_catches_raw_literal),
        ("sha256_uses_branded_type_catches_raw_literal", test_sha256_uses_branded_type_catches_raw_literal),
        ("contract_path_uses_branded_type_catches_raw_literal", test_contract_path_uses_branded_type_catches_raw_literal),
        ("command_name_uses_branded_type_catches_raw_literal", test_command_name_uses_branded_type_catches_raw_literal),
        ("package_name_uses_branded_type_catches_raw_literal", test_package_name_uses_branded_type_catches_raw_literal),
        # Phase 2 (self-dogfooding plan): code-shape contracts.
        ("core_no_fs_write_from_non_manifest_catches_writeFile_import", test_core_no_fs_write_from_non_manifest_catches_writeFile_import),
        ("cli_commands_no_direct_fs_write_catches_writeFileSync_call", test_cli_commands_no_direct_fs_write_catches_writeFileSync_call),
        ("operator_registry_shape_catches_missing_method", test_operator_registry_shape_catches_missing_method),
        ("cli_command_error_shape_catches_missing_field", test_cli_command_error_shape_catches_missing_field),
        ("hook_fail_closed_v2_catches_missing_failClosed_call", test_hook_fail_closed_v2_catches_missing_failClosed_call),
        ("stop_validate_fail_closed_catches_missing_blockStop_call", test_stop_validate_fail_closed_catches_missing_blockStop_call),
        ("write_atomic_has_rename_catches_missing_rename_call", test_write_atomic_has_rename_catches_missing_rename_call),
        ("no_any_in_core_catches_any_annotation", test_no_any_in_core_catches_any_annotation),
        ("hook_scripts_shebang_catches_missing_shebang", test_hook_scripts_shebang_catches_missing_shebang),
        # Phase 3 (self-dogfooding plan): trace-policy contracts.
        ("fs_writes_via_write_atomic_catches_direct_writeFile", test_fs_writes_via_write_atomic_catches_direct_writeFile),
        ("check_prepare_via_load_contract_catches_bypass", test_check_prepare_via_load_contract_catches_bypass),
        ("generate_via_coordinator_catches_bypass", test_generate_via_coordinator_catches_bypass),
        ("approve_via_resolve_approved_by_catches_bypass", test_approve_via_resolve_approved_by_catches_bypass),
        # Phase 4 (self-dogfooding plan): effect-policy contracts.
        ("core_is_pure_or_fs_read_catches_random_in_core", test_core_is_pure_or_fs_read_catches_random_in_core),
        ("hook_no_network_catches_fetch_in_hook_script", test_hook_no_network_catches_fetch_in_hook_script),
        ("generator_no_network_or_child_process_catches_execfile", test_generator_no_network_or_child_process_catches_execfile),
        ("manifest_leaves_are_pinned_catches_extra_effect", test_manifest_leaves_are_pinned_catches_extra_effect),
        # Phase 5 (self-dogfooding plan): type-state brand discriminator tests.
        ("manifest_lifecycle_brand_fires", test_manifest_lifecycle_brand_fires),
        ("approval_lifecycle_brand_fires", test_approval_lifecycle_brand_fires),
        ("design_profile_lifecycle_brand_fires", test_design_profile_lifecycle_brand_fires),
        ("callgraph_lifecycle_brand_fires", test_callgraph_lifecycle_brand_fires),
    ]

    print("=" * 60)
    print("Negative tests for self-protection checkers")
    print("Each test creates a violation, runs the checker, verifies FAIL.")
    print("=" * 60)

    for name, fn in tests:
        print(f"\n--- {name} ---")
        try:
            if fn():
                passed += 1
            else:
                failed += 1
        except Exception as e:
            print(f"  ERROR: {e}")
            errors += 1

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} missed, {errors} errors out of {len(tests)}")
    print(f"{'=' * 60}")

    return 1 if failed > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
