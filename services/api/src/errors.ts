export class ApiProblem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function assert(condition: unknown, status: number, code: string, message: string, details?: unknown): asserts condition {
  if (!condition) throw new ApiProblem(status, code, message, details);
}
