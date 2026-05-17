/**
 * Commands that are known to be read-only (do not write to files on disk)
 * when invoked in their typical usage. Used as a fallback allowlist when
 * {@link extractBashWriteTarget} cannot determine a write target for a
 * bash command.
 *
 * Commands are matched against the **first token** of the command string.
 * If a command is not in this set and no write target can be extracted,
 * the hook denies the command (fail closed).
 *
 * Deliberately excluded:
 * - Interpreters (python, python3, ruby, perl, node) - can write to arbitrary paths via -c flags.
 * - Shell variants (sh, dash) - same reason as bash.
 * - Text editors (vi, vim, nano, emacs) - write by design.
 * - Build tools that emit artifacts (gcc, clang, cargo build) - write outputs.
 * - sed/awk - can modify files in-place with -i/-inplace flags.
 * - curl/wget - can download directly to files with -o flags.
 */
export const KNOWN_SAFE_COMMANDS: ReadonlySet<string> = new Set([
  // Inspection / read-only
  "cat",
  "echo",
  "env",
  "find",
  "grep",
  "head",
  "ls",
  "printenv",
  "pwd",
  "tail",
  "uname",
  "wc",
  "whoami",

  // Comparison / diff
  "diff",

  // Shell builtins (commonly used for flow control)
  "cd",
  "return",
  "set",
  "shift",
  "umask",

  // Shell builtins (conditionals / no-op)
  "false",
  "test",
  "true",

  // NOTE: `git` is NOT included — `git checkout -- <protected-file>` can
  // overwrite protected contract files, and the safe-command allowlist has
  // no subcommand awareness.

  // Package / build tooling (read-only subcommands only)
  // NOTE: `go`, `pip` are NOT included — they can write artifacts to disk
  // (go build, go install, pip install, pip install -e .).
  // Use `stele check` at session stop to catch any drift from these commands.
  "py_compile",
  "pytest",

  // System utilities
  "date",
  "df",
  "du",
  "which",
]);
