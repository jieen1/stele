export class CliCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CliCommandError";
  }
}

export function getExitCode(error: unknown): number | undefined {
  if (error instanceof CliCommandError) {
    return error.exitCode;
  }

  if (typeof error === "object" && error !== null && "exitCode" in error && typeof error.exitCode === "number") {
    return error.exitCode;
  }

  return undefined;
}
