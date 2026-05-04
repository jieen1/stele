import type { SourceSpan } from "../ast/types.js";

export class SteleError extends Error {
  constructor(
    readonly code: string,
    readonly category: string,
    message: string,
    readonly span?: SourceSpan,
    readonly detail?: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "SteleError";
  }
}
