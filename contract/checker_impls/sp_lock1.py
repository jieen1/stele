"""Lock 1 self-protection checkers (scratch_never_hashed, stop_hook_no_full_suite_runner, cli_exit_code_count_exact, cli_no_raw_exit_codes)."""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
from typing import Any

from sp_shared import *  # noqa: F401,F403

__all__ = [
    "scratch_never_hashed",
    "stop_hook_no_full_suite_runner",
    "cli_exit_code_count_exact",
    "_CLI_ALLOWED_EXIT_VALUES",
    "cli_no_raw_exit_codes",
]




def scratch_never_hashed(ctx: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    """C2/G2: incident/proof scratch dirs (.stele/incident, .stele/proofs) must
    never enter the hash boundary -- not via a protected glob in stele.config.json,
    not in the protected manifest, not in the canonical cache hash-manifest.

    Fail closed on inability to read config / the protected manifest / an
    existing cache. An absent cache is fine (nothing has been hashed there).
    The cache path is pinned to core's HASH_MANIFEST_RELATIVE_PATH
    (contract/.cache/hash-manifest.json) -- do NOT guess alternates.
    """
    import fnmatch

    scratch = (".stele/incident", ".stele/proofs")
    probes = (".stele/incident/x.json", ".stele/proofs/x.json")

    def _read_rel(rel: str):
        try:
            return (_REPO_ROOT / rel).read_text(encoding="utf-8")
        except OSError:
            return None

    cfg_text = _read_rel("stele.config.json")
    if cfg_text is None:
        return {"passed": False, "message": "scratch-never-hashed: cannot read stele.config.json (fail-closed)"}
    try:
        cfg = json.loads(cfg_text)
    except json.JSONDecodeError as exc:
        return {"passed": False, "message": f"scratch-never-hashed: stele.config.json invalid JSON: {exc} (fail-closed)"}
    globs = cfg.get("protected")
    if not isinstance(globs, list):
        return {"passed": False, "message": "scratch-never-hashed: stele.config.json has no 'protected' array (fail-closed)"}

    # (a) no declared protected glob may match a scratch probe path
    for glob in globs:
        if not isinstance(glob, str):
            continue
        for probe in probes:
            if fnmatch.fnmatch(probe, glob) or fnmatch.fnmatch(probe, glob.rstrip("/") + "/**"):
                return {"passed": False, "message": f"scratch-never-hashed: protected glob {glob!r} matches scratch path {probe!r}"}

    # A key resolves into scratch if its literal spelling contains a scratch
    # segment OR its realpath (following symlinks, normalizing ./ and //) lands
    # under a scratch dir. The realpath arm closes the symlink/`./`/`//` evasion
    # the plain substring check would miss (review D4). Fail-closed on resolve error.
    scratch_roots = [(_REPO_ROOT / s).resolve() for s in scratch]

    def _key_in_scratch(key: object) -> bool:
        norm = str(key).replace("\\", "/")
        if any(seg in norm for seg in scratch):
            return True
        try:
            resolved = (_REPO_ROOT / norm).resolve()
        except OSError:
            return True  # cannot resolve -> fail closed (treat as suspect)
        return any(resolved == root or root in resolved.parents for root in scratch_roots)

    # (b) the protected manifest must contain no scratch key
    manifest_rel = cfg.get("manifestPath", "contract/.manifest.json")
    manifest_text = _read_rel(manifest_rel)
    if manifest_text is not None:
        try:
            manifest = json.loads(manifest_text)
        except json.JSONDecodeError as exc:
            return {"passed": False, "message": f"scratch-never-hashed: manifest invalid JSON: {exc} (fail-closed)"}
        for key in (manifest.get("protected_files") or {}):
            if _key_in_scratch(key):
                return {"passed": False, "message": f"scratch-never-hashed: manifest protected_files contains scratch path: {key}"}

    # (c) the CANONICAL cache hash-manifest must contain no scratch key. Scan
    # EVERY top-level dict bucket's keys (schema-agnostic) so a future
    # path-keyed map in core's hash-manifest schema cannot smuggle scratch in
    # unscanned (review D6).
    cache_rel = "contract/.cache/hash-manifest.json"
    if (_REPO_ROOT / cache_rel).exists():
        cache_text = _read_rel(cache_rel)
        if cache_text is None:
            return {"passed": False, "message": f"scratch-never-hashed: cache {cache_rel} exists but unreadable (fail-closed)"}
        try:
            cache = json.loads(cache_text)
        except json.JSONDecodeError as exc:
            return {"passed": False, "message": f"scratch-never-hashed: cache invalid JSON: {exc} (fail-closed)"}
        if isinstance(cache, dict):
            for value in cache.values():
                if isinstance(value, dict):
                    for key in value:
                        if _key_in_scratch(key):
                            return {"passed": False, "message": f"scratch-never-hashed: cache hash-manifest contains scratch path: {key}"}

    return {"passed": True, "message": None}




# ===========================================================================
# Lock 1 -- C3 / C4a / C4b  (incident-wedge design lock)
# ===========================================================================

def stop_hook_no_full_suite_runner(ctx: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    """C3: the Stop hook (stop-validate.js) runs ONLY Stele-owned, bounded
    stages -- ``stele check`` + ``pytest tests/contract``. It must never
    (re)introduce a full-project test-suite runner (pnpm/npm/yarn test, vitest,
    jest) or the STELE_CONFORMANCE_ALLOW_SKIP escape hatch. Comments are stripped
    first so a design-rationale comment that names a runner is not flagged. Fail
    closed on read error or if either owned stage is missing / pytest unscoped.
    """
    rel = "packages/claude-code-plugin/scripts/stop-validate.js"
    try:
        raw = (_REPO_ROOT / rel).read_text(encoding="utf-8")
    except OSError:
        return {"passed": False, "message": f"stop-hook-no-full-suite-runner: cannot read {rel} (fail-closed)"}

    src = _strip_js_comments_quote_aware(raw)

    # Denylist of full-suite runners + the removed skip escape-hatch. Broadened
    # (review D1) beyond pnpm/npm/yarn test to common JS runners and recursive
    # workspace invocations an unbounded suite would use. This is a denylist, not
    # a positive spawn-allowlist: a string-assembled command name is out of scope
    # here and is caught defense-in-depth by stop-validate.test.ts asserting the
    # hook never spawns a full-suite runner.
    banned = (
        r"pnpm\s+(?:-\w+\s+)*test\b",
        r"pnpm\s+(?:-\w+\s+)*run\s+test\b",
        r"pnpm\s+-r\b",
        r"pnpm\s+--recursive\b",
        r"npm\s+(?:run\s+)?test\b",
        r"yarn\s+(?:run\s+)?test\b",
        r"bun\s+(?:run\s+)?test\b",
        r"deno\s+test\b",
        r"\bvitest\b",
        r"\bjest\b",
        r"\bmocha\b",
        r"\bnode\s+--test\b",
        r"STELE_CONFORMANCE_ALLOW_SKIP",
    )
    for pat in banned:
        m = re.search(pat, src)
        if m:
            return {
                "passed": False,
                "message": f"stop-hook-no-full-suite-runner: banned full-suite runner / skip token present: {m.group(0)!r}",
            }

    if 'stageName: "stele check"' not in src:
        return {"passed": False, "message": "stop-hook-no-full-suite-runner: missing the 'stele check' stage (fail-closed)"}
    if 'stageName: "pytest tests/contract"' not in src:
        return {"passed": False, "message": "stop-hook-no-full-suite-runner: missing the 'pytest tests/contract' stage (fail-closed)"}
    if '"tests/contract"' not in src:
        return {"passed": False, "message": "stop-hook-no-full-suite-runner: pytest stage no longer scoped to tests/contract (fail-closed)"}

    return {"passed": True, "message": None}




def cli_exit_code_count_exact(ctx: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    """C4a: the ``ExitCode`` const object in packages/cli/src/errors.ts must
    define EXACTLY 8 integer-literal members. Complements exit_codes_valid (which
    checks names/values are correct) by capping the COUNT, so an additive 9th code
    -- even one whose name/value look plausible -- is rejected. Comments are
    stripped first (the object has ``/** ... */`` doc-comments between members).
    Fail closed if the file or the ExitCode object cannot be read / parsed.
    """
    rel = "packages/cli/src/errors.ts"
    try:
        raw = (_REPO_ROOT / rel).read_text(encoding="utf-8")
    except OSError:
        return {"passed": False, "message": f"cli-exit-code-count-exact: cannot read {rel} (fail-closed)"}

    src = _strip_ts_comments(raw)
    m = re.search(r"export\s+const\s+ExitCode\s*=\s*\{(.*?)\}\s*as\s+const\s*;", src, re.DOTALL)
    if m is None:
        return {"passed": False, "message": "cli-exit-code-count-exact: ExitCode const object not found (fail-closed)"}
    body = m.group(1)

    # Split into comma-delimited entries and require EXACTLY 8, each a bare
    # `IDENT: <int-literal>`. Validating every entry (not just counting bare
    # ones) rejects a 9th value smuggled as a spread (`...EXTRA`), a computed key
    # (`["NEW"]: 7`), or an expression value (`Number(7)`, `6 as number`) -- all
    # of which would otherwise keep the bare-literal count at 8 and pass (review D5).
    entries = [e.strip() for e in body.split(",") if e.strip()]
    member_re = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\d+$")
    names: list[str] = []
    for entry in entries:
        mm = member_re.match(entry)
        if mm is None:
            return {
                "passed": False,
                "message": f"cli-exit-code-count-exact: ExitCode entry is not a bare `IDENT: <int>` member: {entry!r} (rejects spreads/computed keys/expression values)",
            }
        names.append(mm.group(1))
    if len(names) != len(set(names)):
        return {"passed": False, "message": f"cli-exit-code-count-exact: duplicate ExitCode member name: {names}"}
    if len(names) != 8:
        return {
            "passed": False,
            "message": f"cli-exit-code-count-exact: ExitCode must define exactly 8 integer-literal members, found {len(names)}: {sorted(names)}",
        }
    return {"passed": True, "message": None}




_CLI_ALLOWED_EXIT_VALUES = {"0", "1", "2", "3", "4", "5", "6", "99"}




def cli_no_raw_exit_codes(ctx: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    """C4b: no CLI source file under packages/cli/src may call ``process.exit(N)``
    or assign ``process.exitCode = N`` with an integer literal that is NOT one of
    the contracted exit values {0,1,2,3,4,5,6,99}. Complements exit_codes_valid
    (the DEFINITION) by pinning call-site USAGE. Member-access (ExitCode.X),
    variable, and expression forms are out of scope (pass). Scans whole-file text
    over *.ts/*.mts/*.cts/*.tsx. Fail closed on dir/enumerate/read error.
    """
    cli_src = _PACKAGES_DIR / "cli" / "src"
    if not cli_src.is_dir():
        return {"passed": False, "message": "cli-no-raw-exit-codes: packages/cli/src not found (fail-closed)"}

    try:
        files = sorted(
            p for p in cli_src.rglob("*")
            if p.is_file() and p.suffix in (".ts", ".mts", ".cts", ".tsx")
        )
    except OSError as exc:
        return {"passed": False, "message": f"cli-no-raw-exit-codes: cannot enumerate sources: {exc} (fail-closed)"}

    call_re = re.compile(r"process\s*\.\s*exit\s*\(\s*([^)]*?)\s*\)", re.DOTALL)
    assign_re = re.compile(r"process\s*\.\s*exitCode\s*=\s*([^\n;]+)")
    lit_re = re.compile(r"(?:\d+|0x[0-9A-Fa-f]+|0o[0-7]+)")
    violations: list[str] = []
    for p in files:
        try:
            text = p.read_text(encoding="utf-8")
        except OSError as exc:
            return {"passed": False, "message": f"cli-no-raw-exit-codes: cannot read {p}: {exc} (fail-closed)"}
        relp = str(p.relative_to(_REPO_ROOT))
        for mm in call_re.finditer(text):
            arg = mm.group(1).strip()
            if lit_re.fullmatch(arg) and arg not in _CLI_ALLOWED_EXIT_VALUES:
                violations.append(f"{relp}: process.exit({arg})")
        for mm in assign_re.finditer(text):
            arg = mm.group(1).strip().rstrip(";").strip()
            if lit_re.fullmatch(arg) and arg not in _CLI_ALLOWED_EXIT_VALUES:
                violations.append(f"{relp}: process.exitCode = {arg}")
    if violations:
        return {
            "passed": False,
            "message": "cli-no-raw-exit-codes: off-contract exit literal(s): " + "; ".join(violations[:5]),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}
