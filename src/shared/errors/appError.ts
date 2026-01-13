export type ErrorCode =
  | "VALIDATION_FAILED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "TRANSIENT_FAILURE"
  | "SAFETY_LOCKOUT_RISK"
  | "NOT_INSTALLED";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(params: { code: ErrorCode; message: string; retryable?: boolean; details?: unknown }) {
    super(params.message);
    this.name = "AppError";
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.details = params.details;
  }
}

