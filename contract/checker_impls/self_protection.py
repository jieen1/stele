"""Self-protection checkers for the Stele framework.

Each function receives (ctx: dict, **kwargs) and returns
{"passed": bool, "message": str | None}.

These checkers inspect the actual Stele monorepo at test time.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
from typing import Any

# Resolve monorepo root relative to this file.
# contract/checker_impls/self_protection.py -> root is ../../..
_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
_PACKAGES_DIR = _REPO_ROOT / "packages"

# ---------------------------------------------------------------------------
# Cached data (avoid re-reading files multiple times)
# ---------------------------------------------------------------------------

_backend_registry_cache: list[dict[str, Any]] | None = None
_stele_files_cache: list[pathlib.Path] | None = None


# ---------------------------------------------------------------------------
# Patterns that look like potential secrets in source files.
# ---------------------------------------------------------------------------

_SECRET_PATTERNS = re.compile(
    r"""
    (?:
        sk-[A-Za-z0-9]{16,}            # OpenAI-style keys
      | [A-Za-z0-9_]*api[_\-]?key[A-Za-z0-9_]*\s*[:=]\s*["'][A-Za-z0-9]{16,}["']  # inline key
      | password\s*[:=]\s*["'][^"\']{4,}["']  # hardcoded password
      | secret[_\-]?key\s*[:=]\s*["'][A-Za-z0-9]{12,}["']  # secret key
      | bearer\s+[A-Za-z0-9=\._\-]{20,}  # bearer token (min 20 chars to reduce FP)
      | token\s*[:=]\s*["'][A-Za-z0-9]{16,}["']  # token assignment
      | AKIA[A-Z0-9]{16}               # AWS Access Key ID
      | eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-./+=]{10,}  # JWT
      | ghp_[A-Za-z0-9]{36}            # GitHub PAT
      | glpat\-[A-Za-z0-9_\-]{20,}    # GitLab PAT
    )
    """,
    re.VERBOSE | re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_backend_registry() -> list[dict[str, Any]]:
    """Parse backend-registry.ts source to extract backend entries."""
    global _backend_registry_cache
    if _backend_registry_cache is not None:
        return _backend_registry_cache

    registry_file = _PACKAGES_DIR / "cli" / "src" / "backend-registry.ts"
    if not registry_file.exists():
        _backend_registry_cache = []
        return []

    content = registry_file.read_text(encoding="utf-8")

    # Parse each backend entry block: { language: "...", framework: "...", ... }
    entries: list[dict[str, Any]] = []
    # Match { ... } blocks that contain language
    block_pattern = re.compile(r"\{\s*\n(?:[^{}]*\n)*?\s*\}", re.MULTILINE)
    for block_match in block_pattern.finditer(content):
        block = block_match.group()
        lang_match = re.search(r"language:\s*\"([^\"]+)\"", block)
        fw_match = re.search(r"framework:\s*\"([^\"]+)\"", block)
        pkg_match = re.search(r"packageName:\s*\"([^\"]+)\"", block)
        if lang_match:
            entries.append({
                "language": lang_match.group(1),
                "framework": fw_match.group(1) if fw_match else "",
                "packageName": pkg_match.group(1) if pkg_match else "",
            })

    _backend_registry_cache = entries
    return entries


def _read_stele_files() -> list[pathlib.Path]:
    """Find all .stele files in the monorepo."""
    global _stele_files_cache
    if _stele_files_cache is not None:
        return _stele_files_cache

    skip = {"node_modules", ".git", "__pycache__", "dist", ".pytest_cache"}
    result: list[pathlib.Path] = []
    for root, dirs, files in os.walk(str(_REPO_ROOT), followlinks=False):
        dirs[:] = [d for d in dirs if d not in skip and not d.startswith(".")]
        for fname in files:
            if fname.endswith(".stele") and not fname.startswith("."):
                result.append(pathlib.Path(root, fname))

    _stele_files_cache = sorted(result)
    return _stele_files_cache


def _read_config() -> dict[str, Any]:
    """Read stele.config.json from repo root."""
    config_path = _REPO_ROOT / "stele.config.json"
    if not config_path.exists():
        return {}
    return json.loads(config_path.read_text(encoding="utf-8"))


def _normalize_version(ver: str) -> tuple[str, ...]:
    """Normalize version string to comparable tuple."""
    # "0.1" -> ("0", "1", "0"), "0.1.0" -> ("0", "1", "0")
    parts = ver.split(".")
    result = []
    for p in parts:
        try:
            result.append(str(int(p)))
        except ValueError:
            result.append(p)
    while len(result) < 3:
        result.append("0")
    return tuple(result)


# ---------------------------------------------------------------------------
# Checker implementations
# ---------------------------------------------------------------------------


def backend_registries(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify the backend registry contains all 5 languages."""
    backends = _load_backend_registry()
    expected = {"python", "typescript", "go", "rust", "java"}
    found = {b["language"] for b in backends}
    missing = expected - found
    if missing:
        return {"passed": False, "message": f"Missing backends: {sorted(missing)}"}
    if len(backends) != 5:
        return {
            "passed": False,
            "message": f"Expected 5 backends, found {len(backends)}",
        }
    return {"passed": True}


def backend_contains_python(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    return _check_backend_present("python")


def backend_contains_typescript(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    return _check_backend_present("typescript")


def backend_contains_go(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    return _check_backend_present("go")


def backend_contains_rust(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    return _check_backend_present("rust")


def backend_contains_java(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    return _check_backend_present("java")


def _check_backend_present(language: str) -> dict[str, Any]:
    backends = _load_backend_registry()
    langs = {b["language"] for b in backends}
    if language not in langs:
        return {"passed": False, "message": f"Backend '{language}' not in registry"}
    return {"passed": True}


def all_backends_compile(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify every registered backend has a buildable dist/ output.

    For each entry in REGISTERED_BACKENDS, check that the package's
    dist/index.js and dist/index.d.ts both exist on disk. The package
    directory is derived from the npm package name
    (e.g. "@stele/backend-go" -> "packages/backend-go").
    """
    backends = _load_backend_registry()
    if not backends:
        return {"passed": False, "message": "Backend registry could not be parsed."}

    missing: list[str] = []
    for entry in backends:
        package_name = entry.get("packageName", "")
        if not package_name.startswith("@stele/"):
            missing.append(f"{entry.get('language', '?')}: unrecognized packageName '{package_name}'")
            continue
        package_dir_name = package_name.split("/", 1)[1]
        pkg_dir = _PACKAGES_DIR / package_dir_name
        index_js = pkg_dir / "dist" / "index.js"
        index_dts = pkg_dir / "dist" / "index.d.ts"
        if not index_js.is_file():
            missing.append(f"{package_name}: missing dist/index.js")
        if not index_dts.is_file():
            missing.append(f"{package_name}: missing dist/index.d.ts")

    if missing:
        return {
            "passed": False,
            "message": "Some backends are not built: " + "; ".join(missing),
        }
    return {"passed": True}


def config_schema_valid(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify stele.config.json contains all required fields."""
    config = _read_config()
    required = {"version", "contractDir", "entry", "generatedDir", "targetLanguage", "testFramework", "protected", "pathMode", "manifestPath", "checkerImplDir"}
    missing = required - set(config.keys())
    if missing:
        return {"passed": False, "message": f"Missing config fields: {sorted(missing)}"}
    return {"passed": True}


def manifest_version_stable(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify manifest format is consistent with config version."""
    config = _read_config()
    manifest_path = _REPO_ROOT / "contract" / ".manifest.json"
    if not manifest_path.exists():
        return {"passed": False, "message": "Manifest is missing. Run 'stele check' to generate it."}

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {
            "passed": False,
            "message": "Manifest exists but is not valid JSON",
        }

    config_ver = config.get("version", "0.1")
    manifest_ver = manifest.get("stele_version")
    if manifest_ver is None:
        return {
            "passed": False,
            "message": "Manifest missing stele_version field",
        }

    # Normalize: "0.1" == "0.1.0"
    config_parts = _normalize_version(config_ver)
    manifest_parts = _normalize_version(manifest_ver)
    if config_parts[:2] != manifest_parts[:2]:
        return {
            "passed": False,
            "message": f"Config version {config_ver} != manifest stele_version {manifest_ver}",
        }
    return {"passed": True}


def exit_codes_valid(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify CLI exit codes match the spec — ALL 8 codes checked.

    Round 5 K-07: added SCORE_BELOW_THRESHOLD=6 which already lived in
    errors.ts + the CLI spec but was missing from this checker. The
    invariant description was likewise updated from "7 codes" to "8 codes".
    """
    errors_ts = _PACKAGES_DIR / "cli" / "src" / "errors.ts"
    if not errors_ts.exists():
        return {"passed": False, "message": "errors.ts not found"}

    content = errors_ts.read_text(encoding="utf-8")

    # Expected: SUCCESS=0, USER_ERROR=1, CONTRACT_FAIL=2, TAMPER_DETECTED=3,
    #           GENERATION_FAIL=4, CONFIG_ERROR=5, SCORE_BELOW_THRESHOLD=6,
    #           INTERNAL_ERROR=99
    expected_codes = {
        "SUCCESS": "0",
        "USER_ERROR": "1",
        "CONTRACT_FAIL": "2",
        "TAMPER_DETECTED": "3",
        "GENERATION_FAIL": "4",
        "CONFIG_ERROR": "5",
        "SCORE_BELOW_THRESHOLD": "6",
        "INTERNAL_ERROR": "99",
    }

    # Find all KEY: VALUE pairs in the ExitCode object
    code_pattern = re.compile(r"(\w+):\s*(\d+)\s*[,\n]")
    found_codes: dict[str, str] = {}
    for match in code_pattern.finditer(content):
        key, val = match.group(1), match.group(2)
        # Only consider keys from our expected set
        if key in expected_codes:
            found_codes[key] = val

    missing = expected_codes.keys() - found_codes.keys()
    if missing:
        return {
            "passed": False,
            "message": f"Missing exit codes: {sorted(missing)}",
        }

    mismatches = []
    for key, expected_val in expected_codes.items():
        if found_codes.get(key) != expected_val:
            mismatches.append(f"{key}: expected {expected_val}, got {found_codes.get(key, 'missing')}")

    if mismatches:
        return {
            "passed": False,
            "message": f"Exit code mismatches: {'; '.join(mismatches)}",
        }

    return {"passed": True}


def cdl_no_single_quotes(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify no .stele file contains single-quoted strings."""
    violations: list[str] = []
    for stele_file in _read_stele_files():
        content = stele_file.read_text(encoding="utf-8", errors="replace")
        for lineno, line in enumerate(content.splitlines(), 1):
            stripped = line.lstrip()
            if stripped.startswith(";"):
                continue
            # Escape-aware state machine for double-quoted strings.
            in_string = False
            escape = False
            for i, ch in enumerate(line):
                if escape:
                    escape = False
                    continue
                if ch == "\\":
                    if in_string:
                        escape = True
                    continue
                if ch == '"':
                    in_string = not in_string
                elif ch == "'" and not in_string:
                    violations.append(
                        f"{stele_file.relative_to(_REPO_ROOT)}:{lineno} single quote in non-comment"
                    )
                    break
    if violations:
        return {
            "passed": False,
            "message": f"Single quotes in {len(violations)} location(s): {'; '.join(violations[:5])}",
        }
    return {"passed": True}


def cdl_utf8_valid(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify all .stele files are valid UTF-8."""
    for stele_file in _read_stele_files():
        try:
            stele_file.read_bytes().decode("utf-8")
        except UnicodeDecodeError:
            return {
                "passed": False,
                "message": f"Invalid UTF-8: {stele_file.relative_to(_REPO_ROOT)}",
            }
    return {"passed": True}


def versions_pinned_together(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify all packages ship at the same version."""
    pkg_dirs = list(_PACKAGES_DIR.glob("*"))
    versions: set[str] = set()
    mismatches: list[str] = []

    for pkg in sorted(pkg_dirs):
        pkg_json = pkg / "package.json"
        if not pkg_json.exists():
            continue
        try:
            data = json.loads(pkg_json.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        ver = data.get("version")
        if ver:
            if len(versions) > 0 and ver not in versions:
                mismatches.append(f"{pkg.name}: {ver}")
            versions.add(ver)

    if len(mismatches) > 0:
        return {
            "passed": False,
            "message": f"Version mismatch: {', '.join(mismatches)}",
        }
    return {"passed": True}


def no_secrets_in_source(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Scan source files for potential hardcoded secrets."""
    extensions = {".ts", ".js", ".py", ".json"}
    skip_dirs = {"node_modules", "dist", "__pycache__", ".git"}
    violations: list[str] = []

    for root, dirs, files in os.walk(str(_REPO_ROOT), followlinks=False):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
        for fname in files:
            is_env_file = fname.startswith('.env')
            if not any(fname.endswith(ext) for ext in extensions) and not is_env_file:
                continue
            fpath = pathlib.Path(root) / fname
            try:
                content = fpath.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            for match in _SECRET_PATTERNS.finditer(content):
                snippet = match.group()
                # Skip obvious redacted values and placeholder patterns.
                if "<redacted>" in snippet or "REDACTED" in snippet.upper():
                    continue
                if "REPLACE" in snippet.upper() or "EXAMPLE" in snippet.upper():
                    continue
                if "${{" in snippet:  # GitHub Actions template
                    continue
                violations.append(
                    f"{fpath.relative_to(_REPO_ROOT)}:{match.start()}: {snippet[:40]}"
                )

    if violations:
        return {
            "passed": False,
            "message": f"Potential secrets in {len(violations)} location(s): {'; '.join(violations[:5])}",
        }
    return {"passed": True}


def generation_deterministic(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify that generation is deterministic — same input produces same output.

    HEURISTIC CHECK: This is a content scan, not a byte-stability verification.
    It looks for common sources of nondeterminism in generated files.
    True determinism verification requires comparing outputs across runs.

    Check generated files for timestamps, random values, UUIDs, or other
    nondeterministic content.
    """
    config = _read_config()
    generated_dir = _REPO_ROOT / config.get("generatedDir", "tests/contract")
    if not generated_dir.exists():
        return {"passed": True, "message": "No generated files yet"}

    # Timestamps: ISO-8601 dates
    timestamp_pattern = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}")
    # UUIDs (case-insensitive)
    uuid_pattern = re.compile(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    )
    # Epoch milliseconds (13-digit numbers)
    epoch_pattern = re.compile(r"\b\d{13}\b")
    # Non-deterministic sort output: object keys in apparent random order
    # (e.g., mixed-case keys that suggest unsorted iteration over dict keys)
    unsorted_keys_pattern = re.compile(
        r"\{\s*[A-Z][a-z]+.*[a-z][A-Z]"  # uppercase then lowercase key pattern
    )
    # Randomized variable names or identifiers (common temp/random patterns)
    random_id_pattern = re.compile(
        r"(?:__tmp_|_rand_|_tmp_)[a-z0-9]{8,}"  # randomized temp identifiers
    )

    for gen_file in sorted(generated_dir.rglob("*")):
        if gen_file.suffix in {".pyc"}:
            continue
        if not gen_file.is_file():
            continue
        content = gen_file.read_text(encoding="utf-8", errors="replace")
        for pat, label in [
            (timestamp_pattern, "timestamp"),
            (uuid_pattern, "UUID"),
            (epoch_pattern, "epoch-timestamp"),
            (unsorted_keys_pattern, "unsorted-keys"),
            (random_id_pattern, "randomized-identifier"),
        ]:
            if pat.search(content):
                return {
                    "passed": False,
                    "message": f"Generated file {gen_file.name} contains {label}",
                }
    return {"passed": True}


def path_no_traversal(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify generated files don't escape the output directory via traversal.

    Checks BOTH:
    1. File paths themselves (no `..` in resolved path outside generated dir)
    2. File contents (no `..`, null bytes, or URL-encoded traversal)
    """
    config = _read_config()
    generated_dir = _REPO_ROOT / config.get("generatedDir", "tests/contract")
    if not generated_dir.exists():
        return {"passed": True, "message": "No generated files yet"}

    generated_resolved = generated_dir.resolve()

    # Check 1: File path safety — all generated files must be under generated_dir
    for gen_file in sorted(generated_dir.rglob("*")):
        if not gen_file.is_file():
            continue
        try:
            resolved = gen_file.resolve()
            if not str(resolved).startswith(str(generated_resolved)):
                return {
                    "passed": False,
                    "message": f"File outside generated dir: {gen_file.name}",
                }
        except OSError:
            continue

    # Check 2: File content — no traversal sequences
    binary_suffixes = {".pyc", ".pyo", ".pyd", ".dll", ".so", ".whl"}
    # URL-encoded traversal patterns
    url_traversal = re.compile(r"(?:%2e%2e|%252e%252e|%2E%2E)[/\\%]", re.IGNORECASE)

    for gen_file in sorted(generated_dir.rglob("*")):
        if not gen_file.is_file():
            continue
        if gen_file.suffix in binary_suffixes:
            continue
        try:
            content = gen_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        # Check for null bytes
        if "\x00" in content:
            return {
                "passed": False,
                "message": f"Null byte in {gen_file.name}",
            }

        # Check for URL-encoded traversal
        if url_traversal.search(content):
            return {
                "passed": False,
                "message": f"URL-encoded traversal in {gen_file.name}",
            }

        # Check for path traversal in non-comment lines
        if ".." in content:
            suspicious = [
                line.strip()
                for line in content.splitlines()
                if ".." in line
                and not line.strip().startswith("#")
                and not line.strip().startswith('"')
                and not line.strip().startswith("'")
                and "..." not in line  # Python Ellipsis is fine
            ]
            if suspicious:
                return {
                    "passed": False,
                    "message": f"Path traversal in {gen_file.name}: {suspicious[0][:80]}",
                }

    return {"passed": True}


# ---------------------------------------------------------------------------
# New checkers (added for comprehensive self-protection)
# ---------------------------------------------------------------------------


def operator_count_stable(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify the operator registry has the expected minimum operator count."""
    operators_ts = _PACKAGES_DIR / "core" / "src" / "registry" / "operators.ts"
    if not operators_ts.exists():
        return {"passed": False, "message": "operators.ts not found"}

    content = operators_ts.read_text(encoding="utf-8")

    # Count defineOperator( calls
    count = len(re.findall(r"defineOperator\s*\(", content))
    # Minimum count: we registered 70+ operators.
    # This catches accidental deletion from the array.
    if count < 50:
        return {
            "passed": False,
            "message": f"Operator count dropped to {count} (expected >= 50)",
        }
    return {"passed": True, "message": f"Operator count: {count}"}


def operator_spec_consistent(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify every operator spec has all required fields."""
    operators_ts = _PACKAGES_DIR / "core" / "src" / "registry" / "operators.ts"
    if not operators_ts.exists():
        return {"passed": False, "message": "operators.ts not found"}

    content = operators_ts.read_text(encoding="utf-8")

    # Check that CORE_OPERATOR_SPECS exists and defineOperator is used consistently
    if "CORE_OPERATOR_SPECS" not in content:
        return {"passed": False, "message": "CORE_OPERATOR_SPECS not found"}

    # Verify each operator block has name, parameters, returnType, description
    # Extract defineOperator blocks using brace-counting to handle nested braces.
    # Simple regex like r"defineOperator\(\{...\}\)" breaks on nested "}".
    def _extract_operator_blocks(text):
        """Extract the inner content of each defineOperator({...}) block."""
        results = []
        marker = "defineOperator"
        start = 0
        while True:
            idx = text.find(marker, start)
            if idx == -1:
                break
            lp = text.find("(", idx)
            if lp == -1:
                start = idx + 1
                break
            lb = text.find("{", lp)
            if lb == -1:
                start = lp + 1
                break
            depth = 0
            i = lb
            while i < len(text):
                if text[i] == "{":
                    depth += 1
                elif text[i] == "}":
                    depth -= 1
                    if depth == 0:
                        results.append(text[lb+1:i])
                        break
                i += 1
            start = i + 1
        return results

    bad_blocks = []
    for block_text in _extract_operator_blocks(content):
        has_name = bool(re.search(r"name:\s*", block_text))
        has_params = bool(re.search(r"parameters:\s*", block_text))
        has_return = bool(re.search(r"returnType:\s*", block_text))
        has_desc = bool(re.search(r"description:\s*", block_text))

        if not (has_name and has_params and has_return and has_desc):
            # Get the name if available for identification
            name_match = re.search(r"name:\s*\"([^\"]+)\"", block_text)
            name = name_match.group(1) if name_match else "<unknown>"
            missing = []
            if not has_name:
                missing.append("name")
            if not has_params:
                missing.append("parameters")
            if not has_return:
                missing.append("returnType")
            if not has_desc:
                missing.append("description")
            bad_blocks.append(f"{name} missing: {', '.join(missing)}")

    if bad_blocks:
        return {
            "passed": False,
            "message": f"Inconsistent operator specs: {'; '.join(bad_blocks[:5])}",
        }
    return {"passed": True}


def manifest_hash_algorithm(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify manifest hashing uses SHA-256 (security-critical)."""
    manifest_dir = _PACKAGES_DIR / "core" / "src" / "manifest"
    if not manifest_dir.exists():
        return {"passed": False, "message": "manifest/ directory not found"}

    # Check manifest.ts for hash algorithm
    manifest_ts = manifest_dir / "manifest.ts"
    if not manifest_ts.exists():
        return {"passed": False, "message": "manifest.ts not found"}

    content = manifest_ts.read_text(encoding="utf-8")

    # Verify SHA-256 is used
    if 'createHash("sha256")' not in content:
        # Also check for single-quote variant
        if "createHash('sha256')" not in content:
            return {
                "passed": False,
                "message": "Manifest must use SHA-256 hashing",
            }

    # Check that no weaker algorithm is used
    weak_algorithms = ["md5", "sha1", "sha224", "sha384", "sha512"]
    for algo in weak_algorithms:
        pattern = f'createHash("{algo}")'
        if pattern in content:
            return {
                "passed": False,
                "message": f"Weak hash algorithm found: {algo}",
            }

    return {"passed": True}


def structural_types_stable(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify the 9 structural types are present."""
    types_ts = _PACKAGES_DIR / "core" / "src" / "ast" / "types.ts"
    if not types_ts.exists():
        return {"passed": False, "message": "types.ts not found"}

    content = types_ts.read_text(encoding="utf-8")

    expected_types = {
        "Number", "String", "Boolean", "Path",
        "Collection", "Predicate", "TimeRange", "Symbol", "Unknown",
    }

    found_types = set()
    for type_name in expected_types:
        # Look for | "TypeName" pattern in SteleType union
        if f'"{type_name}"' in content:
            found_types.add(type_name)

    missing = expected_types - found_types
    if missing:
        return {
            "passed": False,
            "message": f"Missing structural types: {sorted(missing)}",
        }
    return {"passed": True}


def hooks_fail_closed(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify security-critical hooks fail closed (exit non-zero on error)."""
    scripts_dir = _PACKAGES_DIR / "claude-code-plugin" / "scripts"
    if not scripts_dir.exists():
        return {"passed": False, "message": "scripts/ directory not found"}

    # pre-tool-protect.js must have a top-level try/catch that calls failClosed
    pre_tool_protect = scripts_dir / "pre-tool-protect.js"
    if not pre_tool_protect.exists():
        return {"passed": False, "message": "pre-tool-protect.js not found"}

    content = pre_tool_protect.read_text(encoding="utf-8")

    # Check for fail-closed pattern: try/catch with exit non-zero
    has_try = "try {" in content or "try{" in content
    has_fail_closed = "failClosed" in content or "process.exit(" in content
    has_block_exit = "process.exit(BLOCK_EXIT_CODE)" in content or "BLOCK_EXIT_CODE" in content

    if not has_try:
        return {
            "passed": False,
            "message": "pre-tool-protect.js missing top-level try block",
        }
    if not has_fail_closed:
        return {
            "passed": False,
            "message": "pre-tool-protect.js must fail closed on error",
        }

    # stop-validate.js: must exit non-zero on stele check failure
    stop_validate = scripts_dir / "stop-validate.js"
    if not stop_validate.exists():
        return {"passed": False, "message": "stop-validate.js not found"}

    stop_content = stop_validate.read_text(encoding="utf-8")
    if "process.exit(STOP_BLOCK_EXIT_CODE)" not in stop_content and "blockStop(" not in stop_content:
        return {
            "passed": False,
            "message": "stop-validate.js must block on contract failure",
        }

    # Fail-open detection: scan all hook scripts for patterns that indicate
    # the hook allows execution to proceed on error (fail-open behavior).
    hook_scripts_to_check = ["pre-tool-protect.js", "stop-validate.js",
                              "observation-hook.js", "pre-tool-protect.js"]
    fail_open_violations: list[str] = []

    for script_name in sorted(set(hook_scripts_to_check)):
        script_path = scripts_dir / script_name
        if not script_path.exists():
            continue
        script_content = script_path.read_text(encoding="utf-8")
        lines = script_content.splitlines()

        # Check 1: Look for 'exit 0' or 'process.exit(0)' in error handling paths
        # (not at the end of a success path)
        in_error_handler = False
        brace_depth = 0
        for i, line in enumerate(lines):
            stripped = line.strip()
            # Track if we're inside a catch block
            if re.search(r'\bcatch\s*\(', stripped) or re.search(r'\bexcept\b', stripped):
                in_error_handler = True
                brace_depth = 0
            if in_error_handler:
                brace_depth += stripped.count('{') - stripped.count('}')
                # Check for exit 0 / process.exit(0) in error handler
                if re.search(r'(?:process\.)?exit\s*\(\s*0\s*\)', stripped):
                    fail_open_violations.append(
                        f'{script_name}:{i+1} exit(0) in error handler (fail-open)'
                    )
                if brace_depth <= 0 and '{' in ''.join(lines[max(0,i-3):i]):
                    in_error_handler = False

        # Check 2: Look for missing try/except around critical operations
        # (hooks that do file IO without error handling)
        has_file_io = bool(re.search(r'(readFileSync|readFile|writeFileSync|fs\.)', script_content))
        has_try_catch = 'try {' in script_content or 'try{' in script_content
        if has_file_io and not has_try_catch:
            fail_open_violations.append(
                f'{script_name}: file IO without try/catch wrapper'
            )

        # Check 3: Look for hooks that return success on error
        # e.g., 'return true' or 'resolve(' in catch blocks
        catch_blocks = re.findall(
            r'catch\s*\([^)]*\)\s*\{([^}]+)\}', script_content
        )
        for catch_body in catch_blocks:
            if re.search(r'(?:return\s+(?:true|ok|pass)|resolve\s*\()', catch_body):
                fail_open_violations.append(
                    f'{script_name}: catch block returns success signal'
                )

    if fail_open_violations:
        return {
            "passed": False,
            "message": f"Fail-open patterns detected: {'; '.join(fail_open_violations[:5])}",
        }

    return {"passed": True}


def hooks_registration_complete(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify all hook scripts in hooks.json exist."""
    hooks_json = _PACKAGES_DIR / "claude-code-plugin" / "hooks" / "hooks.json"
    if not hooks_json.exists():
        return {"passed": False, "message": "hooks.json not found"}

    try:
        hooks_data = json.loads(hooks_json.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"passed": False, "message": "hooks.json is not valid JSON"}

    scripts_dir = _PACKAGES_DIR / "claude-code-plugin" / "scripts"
    missing_scripts: list[str] = []

    # Extract all script references from hooks.json
    def find_scripts(obj: Any) -> list[str]:
        scripts: list[str] = []
        if isinstance(obj, dict):
            for v in obj.values():
                scripts.extend(find_scripts(v))
        elif isinstance(obj, list):
            for item in obj:
                scripts.extend(find_scripts(item))
        elif isinstance(obj, str):
            # Look for script references
            match = re.search(r"scripts/([\w-]+\.js)", obj)
            if match:
                scripts.append(match.group(1))
        return scripts

    referenced_scripts = set(find_scripts(hooks_data))

    for script_name in referenced_scripts:
        script_path = scripts_dir / script_name
        if not script_path.exists():
            missing_scripts.append(script_name)

    if missing_scripts:
        return {
            "passed": False,
            "message": f"Missing hook scripts: {', '.join(missing_scripts)}",
        }
    return {"passed": True}


def required_commands_exist(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify critical CLI commands exist."""
    commands_dir = _PACKAGES_DIR / "cli" / "src" / "commands"
    if not commands_dir.exists():
        return {"passed": False, "message": "commands/ directory not found"}

    # Critical commands that must exist
    required = {"init", "generate", "check", "lock"}
    found: set[str] = set()

    for cmd_file in commands_dir.glob("*.ts"):
        if cmd_file.stem in required:
            found.add(cmd_file.stem)

    missing = required - found
    if missing:
        return {
            "passed": False,
            "message": f"Missing required commands: {sorted(missing)}",
        }
    return {"passed": True}


def config_manifest_path_safe(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify manifestPath validation enforces 2-segment paths."""
    load_config_ts = _PACKAGES_DIR / "cli" / "src" / "config" / "loadConfig.ts"
    if not load_config_ts.exists():
        return {"passed": False, "message": "loadConfig.ts not found"}

    content = load_config_ts.read_text(encoding="utf-8")

    # validateManifestPath must enforce 2 segments
    if "validateManifestPath" not in content:
        return {
            "passed": False,
            "message": "validateManifestPath not found in loadConfig.ts",
        }

    # Check for 2-segment enforcement
    if 'segments.length !== 2' not in content:
        return {
            "passed": False,
            "message": "manifestPath must enforce 2-segment paths",
        }

    return {"passed": True}


def error_code_families_present(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify E-code error families are used in source."""
    # Check that core errors module exists with expected error codes
    errors_dir = _PACKAGES_DIR / "core" / "src" / "errors"
    if not errors_dir.exists():
        return {"passed": False, "message": "core errors/ directory not found"}

    # Check SteleError.ts exists
    stele_error = errors_dir / "SteleError.ts"
    if not stele_error.exists():
        return {"passed": False, "message": "SteleError.ts not found"}

    content = stele_error.read_text(encoding="utf-8")

    # Verify SteleError class exists
    if "class SteleError" not in content and "export class SteleError" not in content:
        return {"passed": False, "message": "SteleError class not found"}

    return {"passed": True}


def cli_exit_code_enum_complete(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify ExitCode enum has all expected values."""
    errors_ts = _PACKAGES_DIR / "cli" / "src" / "errors.ts"
    if not errors_ts.exists():
        return {"passed": False, "message": "errors.ts not found"}

    content = errors_ts.read_text(encoding="utf-8")

    # Check for CliCommandError class
    if "class CliCommandError" not in content:
        return {"passed": False, "message": "CliCommandError class not found"}

    # Check for GenerationError and ConfigError subclasses
    if "class GenerationError" not in content:
        return {"passed": False, "message": "GenerationError class not found"}
    if "class ConfigError" not in content:
        return {"passed": False, "message": "ConfigError class not found"}

    return {"passed": True}


def protected_pattern_safe(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify protected patterns don't escape project root.

    Checks all string literals in the protected array of defaults.ts.
    """
    defaults_ts = _PACKAGES_DIR / "cli" / "src" / "config" / "defaults.ts"
    if not defaults_ts.exists():
        return {"passed": False, "message": "defaults.ts not found"}

    content = defaults_ts.read_text(encoding="utf-8")

    # Extract ALL string patterns from the protected array.
    # The protected array is: protected: [ "pattern1", "pattern2", ... ]
    # Extract between "protected": [...] block
    protected_block = re.search(r'protected:\s*\[(.*?)\]', content, re.DOTALL)
    if not protected_block:
        return {"passed": False, "message": "Could not find protected array in defaults.ts"}

    block_content = protected_block.group(1)
    # Extract all quoted strings (skip template literals and const references)
    patterns = re.findall(r'"([^"]+)"', block_content)

    violations: list[str] = []
    for pattern in patterns:
        # Skip non-path strings (e.g., template variables)
        if pattern.startswith("${") or pattern.startswith("STELE_"):
            continue
        if ".." in pattern:
            violations.append(f"Pattern contains traversal: {pattern}")
        if pattern.startswith("/") or re.match(r"^[A-Za-z]:", pattern):
            violations.append(f"Pattern is absolute: {pattern}")

    if violations:
        return {
            "passed": False,
            "message": f"Unsafe protected patterns: {'; '.join(violations)}",
        }
    return {"passed": True}


# ---------------------------------------------------------------------------
# Phase B self-protection: evaluator packages, CI strictness, fix-hint shape
# ---------------------------------------------------------------------------


_PHASE_B_EVALUATOR_PACKAGES = [
    "@stele/call-graph-core",
    "@stele/trace-evaluator",
    "@stele/type-state-evaluator",
    "@stele/effect-evaluator",
    "@stele/type-driven-evaluator",
]


def all_evaluators_compile(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify every Phase B evaluator package has dist/index.js + dist/index.d.ts.

    Derives the package dir from the npm name (e.g. "@stele/trace-evaluator"
    -> "packages/trace-evaluator") and checks the two required build artifacts.
    """
    violations: list[dict[str, Any]] = []
    for package_name in _PHASE_B_EVALUATOR_PACKAGES:
        if not package_name.startswith("@stele/"):
            violations.append({
                "file": package_name,
                "line": None,
                "column": None,
                "message": f"unrecognized package name '{package_name}'",
            })
            continue
        package_dir_name = package_name.split("/", 1)[1]
        pkg_dir = _PACKAGES_DIR / package_dir_name
        index_js = pkg_dir / "dist" / "index.js"
        index_dts = pkg_dir / "dist" / "index.d.ts"
        if not index_js.is_file():
            violations.append({
                "file": str(index_js.relative_to(_REPO_ROOT)),
                "line": None,
                "column": None,
                "message": f"{package_name}: missing dist/index.js",
            })
        if not index_dts.is_file():
            violations.append({
                "file": str(index_dts.relative_to(_REPO_ROOT)),
                "line": None,
                "column": None,
                "message": f"{package_name}: missing dist/index.d.ts",
            })

    if violations:
        return {
            "passed": False,
            "message": "Some evaluator packages are not built: " + "; ".join(
                v["message"] for v in violations[:5]
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}


_LENIENT_FLAG_RE = re.compile(r"--lenient-")
# Match references to shell + Python + Node scripts that the workflow may
# delegate to: `bash scripts/x.sh`, `python scripts/y.py`, `node tools/z.mjs`,
# `./scripts/x.sh args…`.
# Round 4 E-11 + Reviewer D D-10: extended from shell-only (.sh/.bash/.zsh)
# to also cover `.py`, `.mjs`, `.cjs`, `.js`, `.rb` — anything an agent
# could delegate to from a workflow step.
_SCRIPT_REF_RE = re.compile(
    r"(?:\b(?:bash|sh|zsh|python|python3|node|nodejs|ruby|perl)\s+)?(?P<path>[\w./\-]+\.(?:sh|bash|zsh|py|mjs|cjs|js|rb|pl))\b",
)
# Round 4 E-11 + Reviewer D D-10: workflow steps frequently delegate to
# `pnpm run <script>` / `npm run <script>` / `yarn <script>`. Those scripts
# live in package.json#scripts. Match the `run <name>` to find the target.
_PNPM_RUN_RE = re.compile(r"\b(?:pnpm|npm|yarn)\s+(?:run\s+)?(?P<name>[a-zA-Z][\w:-]*)")
# An env: assignment whose value text contains the literal lenient flag —
# pre-P1-3 the checker only scanned argv lines and missed this.
_ENV_LENIENT_RE = re.compile(
    r"^\s*[A-Z_][A-Z0-9_]*\s*:\s*[\"']?[^\n]*--lenient-",
    re.MULTILINE,
)


def _scan_text_for_lenient(
    rel_path: str,
    content: str,
    violations: list[dict[str, Any]],
) -> None:
    """Round 3 P1-3: surface every `--lenient-` token in a workflow or
    referenced shell script. Caller controls de-duplication."""
    for lineno, line in enumerate(content.splitlines(), 1):
        for m in _LENIENT_FLAG_RE.finditer(line):
            violations.append({
                "file": rel_path,
                "line": lineno,
                "column": m.start() + 1,
                "message": (
                    f"CI uses lenient flag: {line.strip()[:140]}"
                ),
            })
    for m in _ENV_LENIENT_RE.finditer(content):
        lineno = content.count("\n", 0, m.start()) + 1
        # Skip if the same line was already captured by the direct scan above.
        line_text = content.splitlines()[lineno - 1] if lineno - 1 < len(content.splitlines()) else ""
        if any(v["file"] == rel_path and v["line"] == lineno for v in violations):
            continue
        violations.append({
            "file": rel_path,
            "line": lineno,
            "column": 1,
            "message": (
                f"CI env assigns lenient flag (will expand via $VAR in a step): {line_text.strip()[:140]}"
            ),
        })


def strict_mode_default_in_ci(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify no CI workflow passes --lenient-* flags to stele check.

    Scans .github/workflows/*.yml and .github/workflows/*.yaml for any
    occurrence of "--lenient-", plus:
      - any `env:` value containing `--lenient-` (Round 3 P1-3 — shell-var
        injection like `STELE_ARGS: "--lenient-effects"` followed later by
        `stele check $STELE_ARGS`)
      - any shell script referenced from a `run:` line (Round 3 P1-3 — the
        flag may live in a referenced script rather than the workflow itself)

    Absence of the directory is treated as passing — the repo has no CI
    config yet.
    """
    workflows_dir = _REPO_ROOT / ".github" / "workflows"
    if not workflows_dir.is_dir():
        return {
            "passed": True,
            "message": "No .github/workflows/ directory",
            "violations": [],
        }

    violations: list[dict[str, Any]] = []
    referenced_scripts: set[pathlib.Path] = set()
    referenced_pkg_scripts: set[str] = set()
    workflow_files = sorted(
        list(workflows_dir.glob("*.yml")) + list(workflows_dir.glob("*.yaml"))
    )
    for wf in workflow_files:
        try:
            content = wf.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel_wf = str(wf.relative_to(_REPO_ROOT))
        _scan_text_for_lenient(rel_wf, content, violations)
        # Discover referenced standalone scripts (bash / python / node).
        for m in _SCRIPT_REF_RE.finditer(content):
            script_rel = m.group("path").lstrip("./")
            script_path = _REPO_ROOT / script_rel
            if script_path.is_file():
                referenced_scripts.add(script_path)
        # Round 4 E-11: discover `pnpm run <name>` / `npm run <name>` /
        # `yarn <name>` references whose body lives in package.json#scripts.
        for m in _PNPM_RUN_RE.finditer(content):
            referenced_pkg_scripts.add(m.group("name"))

    for script in sorted(referenced_scripts):
        try:
            script_content = script.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel_script = str(script.relative_to(_REPO_ROOT))
        _scan_text_for_lenient(rel_script, script_content, violations)

    # Round 4 E-11: scan every package.json in the workspace for a `scripts`
    # block whose value contains a lenient flag — workflows that delegate
    # via `pnpm run X` would otherwise sneak past the workflow-only scanner.
    package_json_paths = [_REPO_ROOT / "package.json"]
    package_json_paths.extend(_PACKAGES_DIR.glob("*/package.json"))
    for pkg in package_json_paths:
        if not pkg.is_file():
            continue
        try:
            data = json.loads(pkg.read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError):
            continue
        scripts = data.get("scripts")
        if not isinstance(scripts, dict):
            continue
        for name, body in scripts.items():
            if not isinstance(body, str):
                continue
            if "--lenient-" not in body:
                continue
            violations.append({
                "file": str(pkg.relative_to(_REPO_ROOT)),
                "line": None,
                "column": None,
                "message": (
                    f"package.json script '{name}' contains a lenient flag: "
                    + body.strip()[:140]
                ),
            })

    if violations:
        return {
            "passed": False,
            "message": (
                f"CI workflows pass --lenient-* flags in {len(violations)} location(s): "
                + "; ".join(
                    f"{v['file']}:{v['line']}" for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}


_FIX_HINT_SOURCES = [
    "packages/trace-evaluator/src/fix-hint-substitution.ts",
    "packages/type-state-evaluator/src/fix-hint.ts",
    "packages/effect-evaluator/src/fix-hint.ts",
]

# Substrings that must appear at all (loose check, kept for backwards-compat
# with negative test fixtures).
_FIX_HINT_REQUIRED_KEYWORDS = ["code issue", "contract issue", "propose", "[A]", "[B]"]


def _inline_propose_exit_text(body: str, source: str) -> str:
    """Round 3 P1-2: defaultForbiddenEffectFixHint and friends emit their
    `[B]` block by calling `proposeExitText(...)` — a separate function in
    the same file. The structural check needs to see that text, so before
    we analyse a body we replace every `proposeExitText(...)` call with the
    *literal return value* of the function defined in the same file.

    If `proposeExitText` is not exported in this file the body is returned
    unchanged (the structural check will then complain about a missing
    `[B]` branch, which is the right thing).
    """
    if "proposeExitText(" not in body:
        return body
    functions = _extract_exported_function_bodies(source)
    propose = next(
        (b for (name, _line, b) in functions if name == "proposeExitText"),
        None,
    )
    if propose is None:
        return body
    # Strip out the `return [ ... ].join("\n");` template-string scaffolding;
    # what's left between the array's [ ... ] is the actual canonical text.
    return body + "\n" + propose


_RE_A_CODE = re.compile(r"\[A\]\s+Code issue", re.IGNORECASE)
_RE_B_CONTRACT = re.compile(r"\[B\]\s+Contract issue", re.IGNORECASE)
_RE_CHOOSE = re.compile(r"Choose\s+\[A\]\s+or\s+\[B\]\s+before\s+acting", re.IGNORECASE)


def _analyze_fix_hint_structure(body: str) -> list[str]:
    """Round 3 P1-2: enforce *semantic* A/B-branch shape, not just keyword
    presence. The canonical structure is:

        ...head...
        ... "code issue or contract issue?" ...        (lead-in question)
        [A] Code issue — ... <code suggestion> ...
        [B] Contract issue — ... propose ... contract/design/proposals/ ...
        Choose [A] or [B] before acting...

    The pure-keyword check passes pathological inputs like
    `[A] propose this code change to the contract issue` because every
    required substring is present. This function anchors on the canonical
    phrase pairs `[A] Code issue` and `[B] Contract issue` (case-insensitive)
    so a semantically inverted hint is caught even when every individual
    keyword exists somewhere in the body.

    Returns a list of structural failures. Empty list = pass.
    """
    failures: list[str] = []
    match_a = _RE_A_CODE.search(body)
    match_b = _RE_B_CONTRACT.search(body)

    if match_a is None:
        failures.append("missing `[A] Code issue` anchor (with that exact phrasing)")
    if match_b is None:
        failures.append("missing `[B] Contract issue` anchor (with that exact phrasing)")
    if failures:
        return failures

    if match_a.start() > match_b.start():
        failures.append("`[A] Code issue` must appear before `[B] Contract issue`")
        return failures

    # Region between [A] Code issue and [B] Contract issue must contain a
    # concrete code suggestion, not just abstract framing. We do not enforce
    # syntactic backtick-snippet here (that's E0339); we enforce that the
    # text is not silent — at least one full line of advice between A and B.
    a_region = body[match_a.end():match_b.start()]
    if len(a_region.strip()) < 20:
        failures.append(
            "`[A]` branch is empty or too short — must describe a concrete code repair",
        )

    # Round 4 D-09: stronger content-inversion guard. The legacy structural
    # check accepted any text in the [A] region as long as the literal
    # `[A] Code issue` anchor was present. An adversarial hint that says
    #   `[A] Code issue — n/a, this is purely a contract problem, do nothing`
    # would pass. Require the [A] region to contain at least one action verb
    # from a small whitelist that names a code-side repair.
    a_lower = a_region.lower()
    _A_ACTION_VERBS = (
        "fix",
        "change",
        "update",
        "replace",
        "edit",
        "refactor",
        "remove",
        "add",
        "rewrite",
        "annotate",
        "introduce",
        "delete",
        "move",
    )
    # Accept either (a) a literal action verb in the [A] body, OR (b) a
    # template-string interpolation that delegates the action advice to a
    # helper function. The latter is what trace-evaluator's defaultFixHint
    # does — it template-interpolates `codeIssueAdvice(kind, …)` whose
    # branches each begin with a verb like "Insert" / "Route" / "Stop".
    has_verb = any(verb in a_lower for verb in _A_ACTION_VERBS)
    has_delegated_action = "${" in a_region and "}" in a_region
    if not (has_verb or has_delegated_action):
        failures.append(
            "`[A]` branch must contain at least one code-action verb "
            "(fix/change/update/replace/edit/refactor/remove/add/rewrite/"
            "annotate/introduce/delete/move) OR delegate via a "
            "`${codeBranch}` template-string — otherwise it does not "
            "describe a concrete code repair",
        )

    # The [B] region is everything from `[B] Contract issue` onward; it must
    # carry the propose flow + a pointer at the YAML proposal store.
    b_region = body[match_b.start():]
    lower_b = b_region.lower()
    if "propose" not in lower_b:
        failures.append("`[B]` branch must reference the propose flow")
    if "contract/design/proposals" not in lower_b:
        failures.append(
            "`[B]` branch must point at `contract/design/proposals/<id>.yaml` (the YAML proposal store)",
        )

    # The trailing decision prompt is the agent's call-to-action; without it
    # the hint reads as a default suggestion rather than an analysis branch.
    if _RE_CHOOSE.search(body) is None:
        failures.append(
            "missing the trailing `Choose [A] or [B] before acting` decision prompt",
        )

    return failures


def _extract_exported_function_bodies(source: str) -> list[tuple[str, int, str]]:
    """Extract exported TS function bodies via brace counting.

    Returns a list of (function_name, line_no, body_text) tuples for every
    `export function NAME(...)` declaration found. The body text is the
    region between the first `{` after the signature and its matching `}`.
    """
    results: list[tuple[str, int, str]] = []
    decl_pattern = re.compile(r"\bexport\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")
    for match in decl_pattern.finditer(source):
        name = match.group(1)
        # find first opening brace after signature
        lb = source.find("{", match.end())
        if lb == -1:
            continue
        depth = 0
        i = lb
        while i < len(source):
            ch = source[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    body = source[lb + 1:i]
                    line_no = source.count("\n", 0, match.start()) + 1
                    results.append((name, line_no, body))
                    break
            i += 1
    return results


def fix_hint_requires_analysis_branch(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify default fix-hint generators contain the A/B analysis branch.

    For each evaluator's fix-hint source file, locate every exported function
    whose name starts with `default` or ends in `FixHint` (heuristic for
    default-fix-hint generators). Helpers such as `proposeExitText` are
    skipped. Each candidate's body must contain all five required substrings
    (case-insensitive for the words; literal for `[A]` / `[B]`):
        "code issue", "contract issue", "propose", "[A]", "[B]"
    """
    violations: list[dict[str, Any]] = []
    for rel_path in _FIX_HINT_SOURCES:
        abs_path = _REPO_ROOT / rel_path
        if not abs_path.is_file():
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": "fix-hint source file missing",
            })
            continue
        source = abs_path.read_text(encoding="utf-8", errors="replace")
        functions = _extract_exported_function_bodies(source)
        # Heuristic: default-fix-hint generators start with `default`. This
        # excludes helpers like `proposeExitText` and `substituteFixHint`
        # (which substitutes placeholders but doesn't itself emit a hint).
        candidates = [
            (name, line_no, body)
            for (name, line_no, body) in functions
            if name.startswith("default")
        ]
        if not candidates:
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": "no default-fix-hint function found",
            })
            continue
        for name, line_no, body in candidates:
            # Layer 1 — loose keyword presence (back-compat with old negative tests).
            missing: list[str] = []
            for keyword in _FIX_HINT_REQUIRED_KEYWORDS:
                if keyword in ("[A]", "[B]"):
                    if keyword not in body:
                        missing.append(keyword)
                else:
                    if keyword.lower() not in body.lower():
                        missing.append(keyword)
            if missing:
                violations.append({
                    "file": rel_path,
                    "line": line_no,
                    "column": None,
                    "message": (
                        f"{name} missing analysis-branch keywords: "
                        + ", ".join(missing)
                    ),
                })
                # When the keyword-level check fails the structural check would
                # mostly repeat the same complaint; skip the deeper pass to
                # keep the violation list focused.
                continue

            # Layer 2 — Round 3 P1-2 structural check: keywords present but in
            # the wrong branch / wrong order are caught here. Inline
            # `proposeExitText(...)` first so the [B] branch text reaches the
            # analyser (effect/type-state delegate [B] to that helper).
            resolved = _inline_propose_exit_text(body, source)
            structural_failures = _analyze_fix_hint_structure(resolved)
            if structural_failures:
                violations.append({
                    "file": rel_path,
                    "line": line_no,
                    "column": None,
                    "message": (
                        f"{name} structural fix-hint check failed: "
                        + "; ".join(structural_failures)
                    ),
                })

    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} fix-hint function(s) lack required analysis-branch keywords: "
                + "; ".join(
                    f"{v['file']}:{v['line']} {v['message']}"
                    for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}


# Round 5 I-06 / K-04: accept either double-quoted OR single-quoted string
# literals. The pre-Round-5 regex only matched `"..."`, so an agent that
# swapped one of the three lists to single quotes could shrink the
# extracted set silently and the comparison would still report
# "all equal".
_STRING_LITERAL_RE = re.compile(
    r'"([^"\\]*(?:\\.[^"\\]*)*)"|'
    r"'([^'\\]*(?:\\.[^'\\]*)*)'"
)


def _strip_js_comments_quote_aware(source: str) -> str:
    """Round 6 L-02: strip JS line + block comments WITHOUT touching
    characters that fall inside a quoted string literal. Tracks `"`,
    `'`, and `` ` `` strings; recognizes the escape character so an
    escaped quote `\"` doesn't close the string early. Tolerates
    unterminated strings by treating EOF as the close.

    Returns the source with all comments replaced by single spaces
    (preserves character offsets approximately and prevents two
    adjacent identifiers from accidentally fusing).
    """
    out: list[str] = []
    i = 0
    n = len(source)
    state = "code"  # code | line_comment | block_comment | string
    string_quote = ""
    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if state == "code":
            if ch == "/" and nxt == "/":
                state = "line_comment"
                i += 2
                continue
            if ch == "/" and nxt == "*":
                state = "block_comment"
                i += 2
                continue
            if ch == '"' or ch == "'" or ch == "`":
                state = "string"
                string_quote = ch
                out.append(ch)
                i += 1
                continue
            out.append(ch)
            i += 1
            continue
        if state == "line_comment":
            if ch == "\n":
                state = "code"
                out.append("\n")
                i += 1
                continue
            i += 1
            continue
        if state == "block_comment":
            if ch == "*" and nxt == "/":
                state = "code"
                out.append(" ")  # preserve token boundary
                i += 2
                continue
            i += 1
            continue
        if state == "string":
            if ch == "\\":
                # Escape next char (preserve both chars in output).
                out.append(ch)
                if i + 1 < n:
                    out.append(source[i + 1])
                    i += 2
                else:
                    i += 1
                continue
            out.append(ch)
            if ch == string_quote:
                state = "code"
                string_quote = ""
            i += 1
            continue
    return "".join(out)


def _extract_string_array(source: str, anchor: str) -> set[str] | None:
    """Find the array literal following `anchor =` in source and return its
    string literals as a set. Returns None when the anchor is missing.

    Brittle-by-design: it expects an `=` sign between the anchor and the
    array open-bracket, so TypeScript type annotations like
    `readonly string[]` don't trip up the scanner.
    """
    idx = source.find(anchor)
    if idx == -1:
        return None
    # Find the array literal: scan forward for the first `[` that is
    # followed by whitespace + newline (i.e. a multi-line array opener,
    # not the `[]` of a TypeScript type annotation like `readonly string[]`).
    # All three target files use the multi-line format.
    pos = idx + len(anchor)
    lb = -1
    while pos < len(source):
        candidate = source.find("[", pos)
        if candidate == -1:
            return None
        # Look at the next non-space character on the same line; if it's
        # `]`, this is a `string[]`-style type bracket — skip past it.
        tail = source[candidate + 1:].lstrip(" \t")
        if tail.startswith("]"):
            pos = candidate + 1
            continue
        lb = candidate
        break
    if lb == -1:
        return None
    depth = 0
    end = -1
    for i in range(lb, len(source)):
        ch = source[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end == -1:
        return None
    body = source[lb + 1:end]
    # Round 6 L-02: strip BOTH single-line `// …` and `/* … */` block
    # comments via a quote-aware state machine. The pre-L-02 regex only
    # stripped start-of-line block comments to preserve glob patterns
    # inside quoted strings like "packages/*/tsup.config.ts" — but that
    # let an INLINE `/* "phantom" */` comment after a real entry inject
    # phantom literals into the extracted set, masking a real removal.
    # The state machine reads `"`/`'`/`` ` `` quotes and only enters
    # comment-strip mode when not inside a quoted string.
    body = _strip_js_comments_quote_aware(body)
    # Round 5 K-04: refuse if the body contains spread (`...`), template-
    # literal entries (backticks), or any non-string identifier — the
    # checker cannot reason about runtime-computed entries, so we treat
    # their presence as an automatic divergence signal upstream.
    if re.search(r"\.\.\.[a-zA-Z_]", body) or "`" in body:
        return None
    # Capture group 1 (double-quoted) OR group 2 (single-quoted); skip the
    # one that didn't match.
    return {
        (m.group(1) if m.group(1) is not None else m.group(2))
        for m in _STRING_LITERAL_RE.finditer(body)
    }


def _count_string_literals_in_array(source: str, anchor: str) -> int | None:
    """Round 5 I-17: count raw string-literal occurrences in the array
    following `anchor` (without set-canonicalization). Used alongside
    `_extract_string_array` to detect intra-list duplicates."""
    idx = source.find(anchor)
    if idx == -1:
        return None
    pos = idx + len(anchor)
    lb = -1
    while pos < len(source):
        candidate = source.find("[", pos)
        if candidate == -1:
            return None
        tail = source[candidate + 1:].lstrip(" \t")
        if tail.startswith("]"):
            pos = candidate + 1
            continue
        lb = candidate
        break
    if lb == -1:
        return None
    depth = 0
    end = -1
    for i in range(lb, len(source)):
        ch = source[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end == -1:
        return None
    body = source[lb + 1:end]
    # Same Round 6 L-02 quote-aware stripper used by _extract_string_array.
    body = _strip_js_comments_quote_aware(body)
    return sum(1 for _ in _STRING_LITERAL_RE.finditer(body))


def default_protected_consistent(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 4 D-13: the three "default protected patterns" lists must
    agree byte-for-byte (modulo ordering):

      - packages/core/src/config/defaults.ts          DEFAULT_PROTECTED_PATTERNS
      - packages/cli/src/config/defaults.ts            DEFAULT_CONFIG.protected
      - packages/claude-code-plugin/scripts/           DEFAULT_PROTECTED
        pre-tool-protect.js

    A future fix that updates one and forgets the other two would silently
    drop defense-in-depth for some path category. This checker parses each
    file, extracts the literal-string set, and asserts equality.
    """
    # Round 5 J-02: four sources, not three. observation-hook.js carries
    # its own DEFAULT_PROTECTED used by the material-change heuristic for
    # the maintenance audit log; if it drifts the audit log silently
    # under-counts edits to hook scripts / supply-chain / approvals.
    sources = [
        (
            "packages/core/src/config/defaults.ts",
            "DEFAULT_PROTECTED_PATTERNS",
        ),
        (
            "packages/cli/src/config/defaults.ts",
            "protected:",
        ),
        (
            "packages/claude-code-plugin/scripts/pre-tool-protect.js",
            "DEFAULT_PROTECTED",
        ),
        (
            "packages/claude-code-plugin/scripts/observation-hook.js",
            "DEFAULT_PROTECTED",
        ),
    ]
    extracted: list[tuple[str, set[str]]] = []
    violations: list[dict[str, Any]] = []
    for rel_path, anchor in sources:
        abs_path = _REPO_ROOT / rel_path
        if not abs_path.is_file():
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": f"file missing — cannot verify '{anchor}'",
            })
            continue
        content = abs_path.read_text(encoding="utf-8", errors="replace")
        entries = _extract_string_array(content, anchor)
        if entries is None:
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": f"could not extract array following '{anchor}'",
            })
            continue
        # Round 5 I-17: additionally detect duplicate entries within a
        # single list. Without this, `["x", "x"]` looks identical to
        # `["x"]` after set-canonicalization, so an agent could pad a
        # list with duplicates to make a removal invisible.
        raw_count = _count_string_literals_in_array(content, anchor)
        if raw_count is not None and raw_count != len(entries):
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": (
                    f"list contains {raw_count - len(entries)} duplicate "
                    f"entry/entries — checker uses set semantics so duplicates "
                    f"hide divergence"
                ),
            })
        extracted.append((rel_path, entries))

    # Round 5 I-17: additionally check that no single list contains a
    # duplicate entry — a set-equality comparison would silently mask
    # `["x", "x"]` against `["x"]`. We track raw counts above by
    # re-parsing the body and asserting len(list) == len(set).
    # (Implemented as a per-source pre-check.)
    if len(extracted) >= 2:
        base_path, base_set = extracted[0]
        for other_path, other_set in extracted[1:]:
            missing_here = base_set - other_set
            extra_here = other_set - base_set
            if missing_here:
                violations.append({
                    "file": other_path,
                    "line": None,
                    "column": None,
                    "message": (
                        f"missing {len(missing_here)} pattern(s) vs {base_path}: "
                        + ", ".join(sorted(missing_here))
                    ),
                })
            if extra_here:
                violations.append({
                    "file": base_path,
                    "line": None,
                    "column": None,
                    "message": (
                        f"missing {len(extra_here)} pattern(s) vs {other_path}: "
                        + ", ".join(sorted(extra_here))
                    ),
                })

    if violations:
        return {
            "passed": False,
            "message": (
                f"Default protected lists disagree in {len(violations)} place(s): "
                + "; ".join(
                    f"{v['file']} — {v['message']}" for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}


# ---------------------------------------------------------------------------
# Round 4 Phase 3 — Stele dogfood checkers
#
# CLAUDE.md / spec rules that previously had zero mechanical enforcement now
# get a checker apiece. Each one is language-independent (regex on file
# content) so it works regardless of the project's targetLanguage — that
# lets Stele dogfood Phase B-shape rules even before per-language extractors
# land for Python/Go/Rust/Java.
# ---------------------------------------------------------------------------


# Round 5 K-01: match BOTH single-line `import { … } from "./x"` and the
# multi-line idiom used heavily in this codebase:
#     import {
#       foo,
#       bar,
#     } from "./x.js";
# The legacy regex used `[^\n]*?` which stopped at the first newline and
# missed every multi-line case (~30 files in packages/cli/src alone).
# Also covers bare side-effect imports `import "./x.js";` (no `from`).
_ESM_RELATIVE_IMPORT_RE = re.compile(
    r"""
    (?:import|export)               # import / export keyword
    \b                              # word boundary
    [^;]*?                          # arbitrary content (could span newlines)
    \bfrom\s+                       # "from "
    ["'](\.[^"']+)["']              # captured relative specifier (group 1)
    """,
    re.MULTILINE | re.VERBOSE | re.DOTALL,
)
# Side-effect import: `import "./x.js";` (no `from`). Captured separately
# so the simpler form isn't confused by the [^;]*? consuming too much.
_ESM_SIDE_EFFECT_IMPORT_RE = re.compile(
    r'^\s*import\s+["\'](\.[^"\']+)["\']',
    re.MULTILINE,
)


def esm_relative_imports_keep_js(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 4 E-02: CLAUDE.md says "ESM only — TypeScript files use `.js`
    extensions in relative imports". Without enforcement an agent can
    drop the `.js` suffix and the npm consumer's runtime resolution
    fails (Node ESM does not infer extensions).

    Scan every `packages/*/src/**/*.ts` file. For each relative import
    (`./foo` or `../foo`) assert the specifier ends in `.js`. We allow
    a few well-known directory-shaped specifiers (e.g. `./foo/index`
    is not idiomatic in this repo but harmless if present).
    """
    violations: list[dict[str, Any]] = []
    for pkg_dir in sorted(_PACKAGES_DIR.glob("*")):
        if not pkg_dir.is_dir():
            continue
        src_dir = pkg_dir / "src"
        if not src_dir.is_dir():
            continue
        for ts_file in src_dir.rglob("*.ts"):
            if "node_modules" in ts_file.parts or "dist" in ts_file.parts:
                continue
            if str(ts_file).endswith(".d.ts"):
                continue
            try:
                content = ts_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for re_pattern in (_ESM_RELATIVE_IMPORT_RE, _ESM_SIDE_EFFECT_IMPORT_RE):
                for m in re_pattern.finditer(content):
                    specifier = m.group(1)
                    if specifier.endswith(
                        (".json", ".css", ".svg", ".png", ".jpg", ".node", ".js"),
                    ):
                        continue
                    line_no = content.count("\n", 0, m.start()) + 1
                    violations.append({
                        "file": str(ts_file.relative_to(_REPO_ROOT)),
                        "line": line_no,
                        "column": None,
                        "message": (
                            f"relative import \"{specifier}\" must end in `.js` "
                            f"so the file resolves under native ESM (CLAUDE.md)"
                        ),
                    })

    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} relative TS import(s) missing `.js` suffix: "
                + "; ".join(
                    f"{v['file']}:{v['line']}" for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}


# Permission-gate hooks: must fail closed (deny on uncaught error).
# Observation / context hooks (observation-hook.js, lifecycle-context.js)
# are intentionally fail-OPEN by design — a logging or context-injection
# error must NOT block the agent's tool call. CLAUDE.md "Hooks fail closed"
# applies to the permission-gating subset only.
_HOOK_SCRIPTS_DOGFOOD = [
    "packages/claude-code-plugin/scripts/pre-tool-protect.js",
    "packages/claude-code-plugin/scripts/stop-validate.js",
]


def _extract_catch_bodies(source: str) -> list[str]:
    """Round 5 K-02: extract every `catch (...) { ... }` block body via
    brace counting. Returns a list of body strings; ordering matches
    source order. Used by hook_entrypoints_fail_closed to assert at
    least one catch handler ends with a fail-closed exit.
    """
    bodies: list[str] = []
    catch_re = re.compile(r"\}\s*catch\s*(?:\([^)]*\))?\s*\{")
    for match in catch_re.finditer(source):
        lb = match.end() - 1  # the `{`
        depth = 1
        i = lb + 1
        while i < len(source) and depth > 0:
            ch = source[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    bodies.append(source[lb + 1:i])
                    break
            i += 1
    return bodies


def hook_entrypoints_fail_closed(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 4 E-04: CLAUDE.md "Hooks fail closed." Generalises the
    legacy `hooks_fail_closed` checker — which only inspected
    `pre-tool-protect.js` — to all four hook entrypoint scripts. Each
    must contain an outer `try { ... } catch (...) { ... process.exit(non-zero) }`
    pattern so an uncaught error in the hook becomes a deny instead of a
    silent allow.
    """
    violations: list[dict[str, Any]] = []
    for rel_path in _HOOK_SCRIPTS_DOGFOOD:
        abs_path = _REPO_ROOT / rel_path
        if not abs_path.is_file():
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": "hook script missing",
            })
            continue
        content = abs_path.read_text(encoding="utf-8", errors="replace")
        # Heuristic but strict: require a top-level `try {` followed (within
        # the file) by `catch` and a `process.exit(` with a non-zero arg.
        # The legacy `hooks_fail_closed` checker uses the same pattern; we
        # extend it to the other three scripts.
        # Round 5 K-02: pre-K-02 the check accepted any file-scope
        # `try {` + `catch (...)` + non-zero exit / failClosed combination,
        # whether those tokens sat in the same control-flow scope or not.
        # An adversary could swallow the real catch and have an unrelated
        # success-path `process.exit(BLOCK_EXIT_CODE)` elsewhere in the
        # file and still pass.
        #
        # The new check extracts each catch-block body via brace-counting
        # and asserts at least ONE catch body itself ends with a
        # `process.exit(<non-zero>)` / `process.exit(<NAMED>)` /
        # `failClosed(...)`. The file-scope OR'd check is replaced by a
        # body-scoped AND.
        if "try {" not in content and "try{" not in content:
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": "no top-level `try` block — hook will not fail closed on errors",
            })
            continue
        catch_bodies = _extract_catch_bodies(content)
        if not catch_bodies:
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": "no catch handler whose body could be extracted",
            })
            continue
        # Accept any of:
        #   - process.exit(<non-zero-literal>)
        #   - process.exit(<NAMED_CONSTANT>)
        #   - failClosed(...)           (pre-tool-protect's helper)
        #   - blockStop(...)            (stop-validate's helper, calls
        #                                process.exit(STOP_BLOCK_EXIT_CODE))
        body_pattern_re = re.compile(
            r"process\.exit\(\s*(?:[1-9][0-9]*|[A-Z][A-Z0-9_]*)\s*\)|"
            r"failClosed\(|blockStop\(",
        )
        any_catch_fails_closed = any(
            body_pattern_re.search(body) is not None
            for body in catch_bodies
        )
        if not any_catch_fails_closed:
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": (
                    "no catch-block body ends with `process.exit(<non-zero>)` or "
                    "`failClosed(...)` — hook may exit silently on a thrown error"
                ),
            })

    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} hook entrypoint(s) do not fail closed: "
                + "; ".join(
                    f"{v['file']}: {v['message']}" for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}


# Round 5 K-03: also catch dynamic `import("@stele/X")` and bare
# side-effect `import "@stele/X"` (no `from` keyword).
_STELE_PACKAGE_PREFIX_RE = re.compile(
    r"""
    (?:
      \bfrom\s+ ["'] @stele/ ([a-z][\w\-]*) ["']     # import ... from "@stele/X"
      |
      \bimport \s* \( \s* ["'] @stele/ ([a-z][\w\-]*) ["']  # await import("@stele/X")
      |
      ^ \s* import \s+ ["'] @stele/ ([a-z][\w\-]*) ["']  # bare side-effect
    )
    """,
    re.VERBOSE | re.MULTILINE,
)
# Round 5 K-03: ALLOW-list, not deny-list. The pre-Round-5 deny-list
# would silently allow imports from a NEW workspace package the
# implementer hadn't anticipated. Inverting to "only @stele/call-graph-core
# is allowed" closes that vector: any new dep must be ADDED here
# explicitly, with a code review, before it can be imported from
# @stele/core.
_CORE_ALLOWED_DEPS = {
    # call-graph-core: the validator uses NodeId helpers from this package
    # at parse time for `extern:` patterns. It's a leaf-level package with
    # no further @stele/* deps, so the layering still holds.
    "call-graph-core",
}


def core_has_no_stele_deps(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 4 E-08: README/CLAUDE.md describe @stele/core as the leaf of
    the dependency direction (`core ← backend-* ← cli`). Without
    mechanical enforcement, an agent can `import {…} from "@stele/cli"`
    inside `packages/core/src/...` and the package layering silently
    inverts.

    Scan every `packages/core/src/**/*.ts` for `@stele/<x>` imports;
    each one must NOT match `_CORE_FORBIDDEN_DEPS`.
    """
    core_src = _PACKAGES_DIR / "core" / "src"
    if not core_src.is_dir():
        return {"passed": True, "message": "no @stele/core/src", "violations": []}
    violations: list[dict[str, Any]] = []
    for ts_file in core_src.rglob("*.ts"):
        if not ts_file.is_file():
            continue
        try:
            content = ts_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in _STELE_PACKAGE_PREFIX_RE.finditer(content):
            # The regex has three alternation groups; exactly one matches.
            pkg = m.group(1) or m.group(2) or m.group(3)
            if pkg is None or pkg in _CORE_ALLOWED_DEPS:
                continue
            line_no = content.count("\n", 0, m.start()) + 1
            violations.append({
                "file": str(ts_file.relative_to(_REPO_ROOT)),
                "line": line_no,
                "column": None,
                "message": (
                    f"forbidden import `@stele/{pkg}` — @stele/core must be a leaf "
                    f"package; only @stele/call-graph-core is allow-listed"
                ),
            })

    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} forbidden cross-package import(s) inside @stele/core: "
                + "; ".join(
                    f"{v['file']}:{v['line']} ({v['message']})" for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}


def inline_version_sync(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify inline version strings match package.json versions."""
    # Get version from packages/cli/package.json
    cli_pkg = _PACKAGES_DIR / "cli" / "package.json"
    core_pkg = _PACKAGES_DIR / "core" / "package.json"

    versions: dict[str, str] = {}
    for pkg_path in [cli_pkg, core_pkg]:
        if pkg_path.exists():
            try:
                data = json.loads(pkg_path.read_text(encoding="utf-8"))
                ver = data.get("version")
                if ver:
                    versions[pkg_path.parent.name] = ver
            except (json.JSONDecodeError, OSError):
                continue

    if not versions:
        return {"passed": False, "message": "No package.json versions found"}

    # Check manifest.ts for STELE_VERSION matching
    manifest_ts = _PACKAGES_DIR / "core" / "src" / "manifest" / "manifest.ts"
    if manifest_ts.exists():
        content = manifest_ts.read_text(encoding="utf-8")
        stele_ver_match = re.search(r'STELE_VERSION\s*=\s*"([^"]+)"', content)
        if stele_ver_match:
            inline_ver = stele_ver_match.group(1)
            core_ver = versions.get("core", "")
            # Normalize: "0.1.0" matches "0.1"
            if inline_ver != core_ver:
                # Allow "0.1.0" when package.json has "0.1"
                if not (_normalize_version(inline_ver)[:2] == _normalize_version(core_ver)[:2]):
                    return {
                        "passed": False,
                        "message": f"STELE_VERSION {inline_ver} != core package.json {core_ver}",
                    }

    return {"passed": True}
