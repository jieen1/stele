"""Shared constants, regexes, helpers, and caches for Stele self-protection checkers.

Helpers and caches used by 2+ checker groups live here. The cache objects
`_backend_registry_cache` / `_stele_files_cache` are module globals; use
`reset_caches()` to clear them (tests rely on this).
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
from typing import Any

__all__ = [
    "_REPO_ROOT",
    "_PACKAGES_DIR",
    "_backend_registry_cache",
    "_stele_files_cache",
    "_load_backend_registry",
    "_read_stele_files",
    "_read_config",
    "_normalize_version",
    "_check_backend_present",
    "_STRING_LITERAL_RE",
    "_REGEX_CONTEXT_PREV_CHARS",
    "_REGEX_CONTEXT_PREV_KEYWORDS",
    "_is_regex_context",
    "_scan_regex_literal",
    "_strip_js_comments_quote_aware",
    "_strip_ts_comments",
    "_blank_string_interiors",
    "_strip_ts_comments_and_strings",
    "reset_caches",
]



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
    # Phase 1.6 self-dogfooding: packageName entries are wrapped in a
    # smart constructor (`toPackageName(packageName(...))`-style). The
    # match accepts BOTH the raw form (`packageName: "..."`) and the
    # smart-constructor form (`packageName: toPackageName("...")`).
    pkg_pattern = re.compile(
        r"packageName:\s*(?:[A-Za-z_$][\w$]*\s*\(\s*)?\"([^\"]+)\""
    )
    for block_match in block_pattern.finditer(content):
        block = block_match.group()
        lang_match = re.search(r"language:\s*\"([^\"]+)\"", block)
        fw_match = re.search(r"framework:\s*\"([^\"]+)\"", block)
        pkg_match = pkg_pattern.search(block)
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




def _check_backend_present(language: str) -> dict[str, Any]:
    backends = _load_backend_registry()
    langs = {b["language"] for b in backends}
    if language not in langs:
        return {"passed": False, "message": f"Backend '{language}' not in registry"}
    return {"passed": True}




# Round 5 I-06 / K-04: accept either double-quoted OR single-quoted string
# literals. The pre-Round-5 regex only matched `"..."`, so an agent that
# swapped one of the three lists to single quotes could shrink the
# extracted set silently and the comparison would still report
# "all equal".
_STRING_LITERAL_RE = re.compile(
    r'"([^"\\]*(?:\\.[^"\\]*)*)"|'
    r"'([^'\\]*(?:\\.[^'\\]*)*)'"
)




# Round 13 O-04: a `/` is a JavaScript regex-literal opener when the
# previous non-whitespace, non-comment character is one of these
# (or the file starts). After any of these, `/` cannot mean division
# because there is no left operand; it MUST be a regex literal.
# This is the well-known "regex-or-division" heuristic used by every
# real JS tokenizer; it errs on the side of "regex" which is the safe
# direction for our string-blanker (a regex body containing `"`/`'`/
# `` ` `` characters must not switch us into string mode).
_REGEX_CONTEXT_PREV_CHARS = frozenset(
    "([{,;:?=!&|<>+-*/%~^\n"
)


_REGEX_CONTEXT_PREV_KEYWORDS = frozenset({
    "return", "typeof", "delete", "void", "throw", "new", "in",
    "of", "instanceof", "case", "do", "else", "yield", "await",
})




def _is_regex_context(source: str, slash_idx: int) -> bool:
    """Return True if `source[slash_idx]` (which must be `/`) is the
    opener of a regex literal rather than a division operator. Look
    backward past whitespace; classify based on the preceding token.
    """
    j = slash_idx - 1
    while j >= 0 and source[j] in " \t":
        j -= 1
    if j < 0:
        return True
    ch = source[j]
    if ch in _REGEX_CONTEXT_PREV_CHARS:
        return True
    # Identifier or number → division (not regex). EXCEPT for the
    # keyword set above (`return /x/.test(y)` is legal regex).
    if ch.isalnum() or ch == "_" or ch == "$":
        k = j
        while k >= 0 and (source[k].isalnum() or source[k] in "_$"):
            k -= 1
        token = source[k + 1 : j + 1]
        return token in _REGEX_CONTEXT_PREV_KEYWORDS
    return False




def _scan_regex_literal(source: str, start_idx: int) -> int | None:
    """Round 13 O-04: starting at `source[start_idx] == "/"`, scan
    forward past the regex body + flags. Returns the index just past
    the closing `/` and any flags, or None if the candidate is not a
    well-formed regex literal (in which case the caller should treat
    the `/` as something else — usually a comment opener or division).

    Handles `\\` escapes and `[...]` character classes (where `/` is
    literal and `[`/`]` are mode markers).
    """
    n = len(source)
    if start_idx >= n or source[start_idx] != "/":
        return None
    i = start_idx + 1
    in_class = False
    while i < n:
        ch = source[i]
        if ch == "\n":
            # Regex literals cannot span newlines.
            return None
        if ch == "\\":
            # Skip the escaped char.
            i += 2
            continue
        if ch == "[":
            in_class = True
        elif ch == "]" and in_class:
            in_class = False
        elif ch == "/" and not in_class:
            # End of body. Consume flags (`g`, `i`, `m`, `s`, `u`, `y`, `d`).
            i += 1
            while i < n and source[i] in "gimsuyd":
                i += 1
            return i
        i += 1
    return None




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
            # Round 13 O-04: detect regex literal before treating `/` as
            # division. A regex body can contain `"`, `'`, `` ` `` —
            # without this branch, the helper would enter string mode
            # on a quote inside `/["']/` and corrupt downstream output.
            if ch == "/" and _is_regex_context(source, i):
                end = _scan_regex_literal(source, i)
                if end is not None:
                    # Emit the regex literal verbatim — it's code.
                    out.append(source[i:end])
                    i = end
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
            # Round 8 N-05: preserve newlines inside block comments so
            # downstream line-number computations (count("\n", 0, m.start()))
            # don't shift when violations sit below a multi-line `/* ... */`.
            if ch == "\n":
                out.append("\n")
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




# ---------------------------------------------------------------------------
# Round 7 — additional dogfood checkers for CLAUDE.md rules that previously
# had zero mechanical enforcement.
# ---------------------------------------------------------------------------


def _strip_ts_comments(source: str) -> str:
    return _strip_js_comments_quote_aware(source)




def _blank_string_interiors(source: str) -> str:
    """Round 8 N-02 (no_backward_compat_shims companion): blank the
    *interiors* of string / template literals (replace with spaces;
    preserve newlines) but keep comments intact. Length-preserving so
    that match offsets in the returned string equal offsets in the
    original — that's what the shim-marker checker needs in order to
    keep an accurate line number while rejecting smuggled markers.

    Round 9 O-01: template-literal `${...}` interpolations are real
    code (a `${require(...)}` invocation IS a CJS call, not a string).
    On entering a backtick string, scan for unescaped `${` and switch
    back to a nested "code" state until the matching `}` (tracking
    nested `{`/`}` depth). Re-enter template state after.

    Round 9 O-03: the block-comment exit condition is now the standard
    two-char `*/` look-ahead, so `/*/ "x" */` is correctly treated as
    one big block comment (the prior `prev == '*'` form mis-closed
    after the opener's own `*`).
    """
    out: list[str] = []
    i = 0
    n = len(source)
    state = "code"  # code | line_comment | block_comment | string | template
    string_quote = ""
    template_stack: list[int] = []  # entries: brace depth at the `${` entry
    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if state == "code":
            # Round 9 O-01: if we're inside a `${...}` of a template
            # literal, a matching `}` pops back to template state.
            if template_stack and ch == "}":
                if template_stack[-1] == 0:
                    template_stack.pop()
                    state = "template"
                    out.append(ch)
                    i += 1
                    continue
                template_stack[-1] -= 1
            elif template_stack and ch == "{":
                template_stack[-1] += 1
            if ch == "/" and nxt == "/":
                state = "line_comment"
                out.append(ch)
                i += 1
                continue
            if ch == "/" and nxt == "*":
                state = "block_comment"
                out.append(ch)
                out.append(nxt)
                i += 2
                continue
            # Round 13 O-04: regex literal recognition (same rationale
            # as in `_strip_js_comments_quote_aware`).
            if ch == "/" and _is_regex_context(source, i):
                end = _scan_regex_literal(source, i)
                if end is not None:
                    out.append(source[i:end])
                    i = end
                    continue
            if ch == '"' or ch == "'":
                state = "string"
                string_quote = ch
                out.append(ch)
                i += 1
                continue
            if ch == "`":
                state = "template"
                out.append(ch)
                i += 1
                continue
            out.append(ch)
            i += 1
            continue
        if state == "line_comment":
            out.append(ch)
            if ch == "\n":
                state = "code"
            i += 1
            continue
        if state == "block_comment":
            # Round 9 O-03: standard two-char `*/` look-ahead.
            if ch == "*" and nxt == "/":
                out.append(ch)
                out.append(nxt)
                state = "code"
                i += 2
                continue
            out.append(ch)
            i += 1
            continue
        if state == "string":
            if ch == "\\":
                # Escape — blank both chars but preserve newlines.
                out.append(" ")
                if i + 1 < n:
                    out.append("\n" if source[i + 1] == "\n" else " ")
                    i += 2
                else:
                    # Round 9 O-06: emit a space for the trailing `\`
                    # so the output stays length-preserving.
                    out.append(" ")
                    i += 1
                continue
            if ch == string_quote:
                out.append(ch)
                state = "code"
                string_quote = ""
                i += 1
                continue
            out.append("\n" if ch == "\n" else " ")
            i += 1
            continue
        if state == "template":
            if ch == "\\":
                out.append(" ")
                if i + 1 < n:
                    out.append("\n" if source[i + 1] == "\n" else " ")
                    i += 2
                else:
                    out.append(" ")
                    i += 1
                continue
            if ch == "`":
                out.append(ch)
                state = "code"
                i += 1
                continue
            # Round 9 O-01: `${` opens a code-level expression. Switch
            # to code state with a fresh brace-depth counter.
            if ch == "$" and nxt == "{":
                out.append(ch)
                out.append(nxt)
                template_stack.append(0)
                state = "code"
                i += 2
                continue
            out.append("\n" if ch == "\n" else " ")
            i += 1
            continue
    return "".join(out)




def _strip_ts_comments_and_strings(source: str) -> str:
    """Round 8 N-02: like `_strip_ts_comments`, but additionally replaces
    every character INSIDE a string / template literal with a space
    (newlines preserved so line numbers remain stable).

    Why: the Round 7 dogfood checkers (NO_CJS_REQUIRE_IN_TS_SOURCE,
    NO_BACKWARD_COMPAT_SHIMS, CORE_ENGINE_PURITY, CLI_IO_THROUGH_PATH_UTILS)
    scan for forbidden tokens — but a token hidden inside a string
    literal (`const msg = "use require(...)"`) is not actually a
    semantic call; it's text. Without this helper, an agent could
    smuggle the forbidden pattern through, or — worse for
    CLI_IO_THROUGH_PATH_UTILS — could ship code that calls writeFile on
    raw user input AND mention the string `"resolve("` to satisfy the
    safety-helper check.

    The quote characters themselves are preserved, but the interior is
    blanked.

    Round 9 O-01: template-literal `${...}` interpolations are real
    code (a `${require(...)}` invocation IS a CJS call). Recognise
    backtick strings separately, switch back to code state on `${`,
    and pop back to template state on the matching `}`.
    """
    out: list[str] = []
    i = 0
    n = len(source)
    state = "code"
    string_quote = ""
    template_stack: list[int] = []  # brace depth per active `${` frame
    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if state == "code":
            if template_stack and ch == "}":
                if template_stack[-1] == 0:
                    template_stack.pop()
                    state = "template"
                    out.append(ch)  # `}` is code — preserve it
                    i += 1
                    continue
                template_stack[-1] -= 1
            elif template_stack and ch == "{":
                template_stack[-1] += 1
            if ch == "/" and nxt == "/":
                state = "line_comment"
                i += 2
                continue
            if ch == "/" and nxt == "*":
                state = "block_comment"
                i += 2
                continue
            # Round 13 O-04: regex literal recognition. In the
            # strings-blanked helper we preserve the regex body
            # verbatim (it IS code), so the downstream regex
            # searches see it as-is.
            if ch == "/" and _is_regex_context(source, i):
                end = _scan_regex_literal(source, i)
                if end is not None:
                    out.append(source[i:end])
                    i = end
                    continue
            if ch == '"' or ch == "'":
                state = "string"
                string_quote = ch
                out.append(ch)
                i += 1
                continue
            if ch == "`":
                state = "template"
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
                out.append(" ")
                i += 2
                continue
            if ch == "\n":
                out.append("\n")
            i += 1
            continue
        if state == "string":
            if ch == "\\":
                out.append(" ")
                if i + 1 < n:
                    out.append("\n" if source[i + 1] == "\n" else " ")
                    i += 2
                else:
                    # Round 9 O-06: keep length stable on trailing `\` EOF.
                    out.append(" ")
                    i += 1
                continue
            if ch == string_quote:
                out.append(ch)
                state = "code"
                string_quote = ""
                i += 1
                continue
            out.append("\n" if ch == "\n" else " ")
            i += 1
            continue
        if state == "template":
            if ch == "\\":
                out.append(" ")
                if i + 1 < n:
                    out.append("\n" if source[i + 1] == "\n" else " ")
                    i += 2
                else:
                    out.append(" ")
                    i += 1
                continue
            if ch == "`":
                out.append(ch)
                state = "code"
                i += 1
                continue
            # Round 9 O-01: `${...}` — switch to code state, track depth.
            if ch == "$" and nxt == "{":
                # Preserve the `${` opener so a downstream regex anchored
                # on real punctuation still sees it; the inner expression
                # bytes will be processed as code (and re-emitted as-is).
                out.append(ch)
                out.append(nxt)
                template_stack.append(0)
                state = "code"
                i += 2
                continue
            out.append("\n" if ch == "\n" else " ")
            i += 1
            continue
    return "".join(out)

def reset_caches() -> None:
    """Reset the module-level caches. Used by the negative test suite."""
    global _backend_registry_cache, _stele_files_cache
    _backend_registry_cache = None
    _stele_files_cache = None

