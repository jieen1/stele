export const ExitCode = {
  /** Success */
  SUCCESS: 0,
  /** User error (wrong command, wrong arguments) */
  USER_ERROR: 1,
  /** Contract verification failed */
  CONTRACT_FAIL: 2,
  /** Tamper detection (manifest drift) */
  TAMPER_DETECTED: 3,
  /** Generation failed */
  GENERATION_FAIL: 4,
  /** Configuration error */
  CONFIG_ERROR: 5,
  /** Score below threshold (quality gate) */
  SCORE_BELOW_THRESHOLD: 6,
  /** Internal error */
  INTERNAL_ERROR: 99,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class CliCommandError extends Error {
  readonly exitCode: ExitCode;
  override readonly cause?: unknown;
  constructor(message: string, exitCode: ExitCode, cause?: unknown) {
    super(message);
    this.name = "CliCommandError";
    this.exitCode = exitCode;
    this.cause = cause;
  }
}

export function isCliCommandError(error: unknown): error is CliCommandError {
  return error instanceof CliCommandError;
}

export function getExitCode(error: unknown): ExitCode | undefined {
  if (error instanceof CliCommandError) {
    return error.exitCode;
  }

  if (typeof error === "object" && error !== null && "exitCode" in error && typeof error.exitCode === "number") {
    return error.exitCode as ExitCode;
  }

  return undefined;
}

export class GenerationError extends CliCommandError {
  constructor(message: string, cause?: unknown) {
    super(message, ExitCode.GENERATION_FAIL, cause);
    this.name = "GenerationError";
  }
}

export class ConfigError extends CliCommandError {
  constructor(message: string, cause?: unknown) {
    super(message, ExitCode.CONFIG_ERROR, cause);
    this.name = "ConfigError";
  }
}
