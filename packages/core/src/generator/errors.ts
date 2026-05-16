import { SteleError } from "../errors/SteleError.js";

export function generationError(code: string, message: string, detail: string, hint: string): SteleError {
  return new SteleError(code, "Generation Error", message, undefined, detail, hint);
}
