import { apiError, type ApiError, type ApiErrorCode } from "@artoo/domain";

/**
 * Application error that carries an {@link ApiErrorCode} and HTTP status. The
 * Fastify error handler renders it as the frozen `{ error: { code, message,
 * details } }` envelope (design.md §10.6).
 */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
  }

  toEnvelope(): ApiError {
    return apiError(this.code, this.message, this.details);
  }

  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError("validation_error", message, 400, details);
  }

  static notFound(message: string, details?: Record<string, unknown>): AppError {
    return new AppError("not_found", message, 404, details);
  }

  static conflict(message: string, details?: Record<string, unknown>): AppError {
    return new AppError("conflict", message, 409, details);
  }

  static invalidState(message: string, details?: Record<string, unknown>): AppError {
    return new AppError("invalid_state", message, 409, details);
  }

  static permissionDenied(message: string, details?: Record<string, unknown>): AppError {
    return new AppError("permission_denied", message, 403, details);
  }

  static rateLimited(message: string, details?: Record<string, unknown>): AppError {
    return new AppError("rate_limited", message, 429, details);
  }
}
