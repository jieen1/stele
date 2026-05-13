"""Self-protection checkers for the Stele framework.

Each function receives (ctx: dict, **kwargs) and returns
{"passed": bool, "message": str | None}.

These checkers inspect the actual Stele monorepo at test time.
"""
from __future__ import annotations

import json
import pathlib
import re
from typing import Any

# Resolve monorepo root relative to this file.
# contract/checker_impls/self_protection.py -> root is ../../..
_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
_PACKAGES_DIR = _REPO_ROOT / "packages"

# Patterns that look like potential secrets in source files.
_SECRET_PATTERNS = re.compile(
    r"""
    (?:
        sk-[A-Za-z0-9]{16,}           # OpenAI-style keys
      | [A-Za-z0-9_]*api[_-]?key[A-Za-z0-9_]*\s*[:=]\s*["'][A-Za-z0-9]{16,}["']  # inline key
      | password\s*[:=]\s*["'][^"\']{4,}["']  # hardcoded password
      | secret[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{12,}["']  # secret key
      | bearer\s+[A-Za-z0-9_=\-\.]+  # bearer token
      | token\s*[:=]\s*["'][A-Za-z0-9]{16,}["']  # token assignment
    )
    """,
    re.VERBOSE | re.IGNORECASE,
)


def _load_backend_registry() -> list[dict[str, Any]]:
    """Import the backend registry module and list registered backends."""
    try:
        # Dynamic import of the built CLI backend registry.
        import importlib

        spec = importlib.util.find_spec(
            "cli.backend-registry",  # type: ignore
            str(_PACKAGES_DIR / "cli" / "dist"),
        )
        if spec is None:
            # Fallback: read the source file and parse.
            return _parse_backend_registry_source()
    except Exception:
        return _parse_backend_registry_source()
    return _parse_backend_registry_source()


def _parse_backend_registry_source() -> list[dict[str, Any]]:
    """Parse backend-registry.ts source to extract backend entries."""
    registry_file = _PACKAGES_DIR / "cli" / "src" / "backend-registry.ts"
    if not registry_file.exists():
        return []
    content = registry_file.read_text(encoding="utf-8")
    # Each backend entry: { language: "...", framework: "...", ... }
    lang_pattern = re.compile(r"language:\s*\"([^\"]+)\",?")
    frameworks = re.compile(r"framework:\s*\"([^\"]+)\",?")
    languages = lang_pattern.findall(content)
    frameworks_list = frameworks.findall(content)
    return [
        {"language": lang, "framework": fw}
        for lang, fw in zip(languages, frameworks_list)
    ]


def _read_stele_files() -> list[pathlib.Path]:
    """Find all .stele files in the monorepo."""
    result: list[pathlib.Path] = []
    for stele_file in _REPO_ROOT.rglob("*.stele"):
        if stele_file.name.startswith("."):
            continue
        result.append(stele_file)
    return sorted(result)


def _read_config() -> dict[str, Any]:
    """Read stele.config.json from repo root."""
    config_path = _REPO_ROOT / "stele.config.json"
    if not config_path.exists():
        return {}
    return json.loads(config_path.read_text(encoding="utf-8"))


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


def config_schema_valid(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify stele.config.json contains all required fields."""
    config = _read_config()
    required = {"version", "contractDir", "entry", "generatedDir", "targetLanguage", "testFramework"}
    missing = required - set(config.keys())
    if missing:
        return {"passed": False, "message": f"Missing config fields: {sorted(missing)}"}
    return {"passed": True}


def manifest_version_stable(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify manifest format is consistent with config version."""
    config = _read_config()
    manifest_path = _REPO_ROOT / "contract" / ".manifest.json"
    if not manifest_path.exists():
        # No manifest yet — acceptable for first run.
        return {"passed": True, "message": "No manifest yet (first run)"}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    config_ver = config.get("version", "0.1")
    manifest_ver = manifest.get("version", "0.1")
    if config_ver != manifest_ver:
        return {
            "passed": False,
            "message": f"Config version {config_ver} != manifest version {manifest_ver}",
        }
    return {"passed": True}


def exit_codes_valid(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify CLI exit codes match the spec."""
    # Check the check command source for exit code constants.
    check_cmd = _PACKAGES_DIR / "cli" / "src" / "commands" / "check.ts"
    if not check_cmd.exists():
        return {"passed": False, "message": "check.ts not found"}
    content = check_cmd.read_text(encoding="utf-8")
    # Exit code 0 = clean, 2 = generated drift, 3 = manifest drift.
    for code in ("process.exitCode", "exit(2)", "exit(3)"):
        if code not in content:
            return {
                "passed": False,
                "message": f"Expected '{code}' in check.ts",
            }
    return {"passed": True}


def cdl_no_single_quotes(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify no .stele file contains single-quoted strings."""
    violations: list[str] = []
    for stele_file in _read_stele_files():
        content = stele_file.read_text(encoding="utf-8", errors="replace")
        # Skip comments (lines starting with ;).
        for lineno, line in enumerate(content.splitlines(), 1):
            stripped = line.lstrip()
            if stripped.startswith(";"):
                continue
            # Find single quotes not inside double-quoted strings.
            in_string = False
            for i, ch in enumerate(line):
                if ch == '"' and not in_string:
                    in_string = True
                elif ch == '"' and in_string:
                    in_string = False
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
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
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

    for root, dirs, files in __import__("os").walk(str(_PACKAGES_DIR)):
        # Skip hidden and build directories.
        if any(skip in root for skip in skip_dirs):
            continue
        for fname in files:
            if not any(fname.endswith(ext) for ext in extensions):
                continue
            fpath = pathlib.Path(root) / fname
            if skip_dirs & set(fpath.relative_to(_REPO_ROOT).parts):
                continue
            try:
                content = fpath.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            for match in _SECRET_PATTERNS.finditer(content):
                violations.append(
                    f"{fpath.relative_to(_REPO_ROOT)}:{match.start()}: {match.group()[:40]}"
                )

    if violations:
        return {
            "passed": False,
            "message": f"Potential secrets in {len(violations)} location(s): {'; '.join(violations[:5])}",
        }
    return {"passed": True}


def generation_deterministic(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify that generation is deterministic — same input produces same output.

    This is a meta-check: verify that generated files don't contain timestamps,
    random values, or other nondeterministic content.
    """
    generated_dir = _REPO_ROOT / "tests" / "contract"
    if not generated_dir.exists():
        return {"passed": True, "message": "No generated files yet"}

    # Check for timestamps (ISO date patterns in generated code).
    timestamp_pattern = re.compile(
        r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}"
    )
    # Check for random-looking strings (long hex that looks like UUID).
    uuid_pattern = re.compile(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    )

    for gen_file in sorted(generated_dir.rglob("*")):
        if gen_file.suffix in {".pyc"}:
            continue
        if not gen_file.is_file():
            continue
        content = gen_file.read_text(encoding="utf-8", errors="replace")
        for pat, label in [(timestamp_pattern, "timestamp"), (uuid_pattern, "UUID")]:
            if pat.search(content):
                return {
                    "passed": False,
                    "message": f"Generated file {gen_file.name} contains {label}",
                }
    return {"passed": True}


def path_no_traversal(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify generated files don't contain path traversal sequences."""
    generated_dir = _REPO_ROOT / "tests" / "contract"
    if not generated_dir.exists():
        return {"passed": True, "message": "No generated files yet"}

    for gen_file in sorted(generated_dir.rglob("*")):
        if not gen_file.is_file():
            continue
        content = gen_file.read_text(encoding="utf-8", errors="replace")
        if ".." in content:
            # Allow "..." in slice notation (Python).
            suspicious = [
                line.strip()
                for line in content.splitlines()
                if ".." in line and not line.strip().startswith("#")
            ]
            if suspicious:
                return {
                    "passed": False,
                    "message": f"Path traversal in {gen_file.name}: {suspicious[0][:80]}",
                }
    return {"passed": True}
