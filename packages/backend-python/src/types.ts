import {
  type AstNode,
  type ListNode,
} from "@stele/core";

export type PythonExpressionTranslator = (node: AstNode, context?: TranslationContext) => string;

export type PythonOperatorHandler = (
  node: ListNode,
  context: TranslationContext,
  translate: PythonExpressionTranslator,
) => string;

export interface TranslationContext {
  readonly bindings: ReadonlyMap<string, string>;
  readonly rootContextName: string;
  readonly usedNames: ReadonlySet<string>;
  bind(identifier: string): { name: string; context: TranslationContext };
  resolve(identifier: string): string | undefined;
}

export const INDENT = "    ";

export const BASE_RUNTIME_HELPERS = ["stele_call_checker", "stele_get_path", "stele_is_modified", "stele_sum"];
export const SCENARIO_RUNTIME_HELPERS = ["stele_merge_contexts", "stele_run_scenario"];
export const EP04_RUNTIME_HELPERS = [
  "stele_ceil",
  "stele_concat",
  "stele_decimal_eq",
  "stele_first",
  "stele_floor",
  "stele_join",
  "stele_json_path",
  "stele_last",
  "stele_length",
  "stele_lower",
  "stele_map",
  "stele_mod",
  "stele_pow",
  "stele_round",
  "stele_sort_by",
  "stele_sort_by_desc",
  "stele_split",
  "stele_trim",
  "stele_type_of",
  "stele_upper",
];
export const CODE_SHAPE_RUNTIME_HELPERS = [
  "stele_collect_imports",
  "stele_get_class_fields",
  "stele_get_type_hints",
  "stele_glob",
  "stele_has_callable",
  "stele_has_field",
  "stele_import_allowed",
  "stele_read_file",
  "stele_resolve_class",
  "stele_resolve_function",
  "stele_type_matches",
];

export const PYTHON_RESERVED_WORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "match",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "_",
]);

export interface CodeShapeTarget {
  pathPattern: string;
  selectorName?: string;
  selectorFilter?: string;
}
