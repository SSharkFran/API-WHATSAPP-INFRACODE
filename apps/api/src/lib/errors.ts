export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly publicCode: string;
  public readonly details?: Record<string, unknown>;

  public constructor(
    statusCode: number,
    publicCode: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.publicCode = publicCode;
    this.details = details;
  }
}

const hasExtendedErrorProperties = (
  error: Error
): error is Error & {
  statusCode?: number;
  publicCode?: string;
  details?: Record<string, unknown>;
} =>
  "statusCode" in error || "publicCode" in error || "details" in error;

/**
 * Converte erros desconhecidos para um formato consistente de resposta HTTP.
 */
export const normalizeError = (error: unknown): ApiError => {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof Error) {
    const extendedError = hasExtendedErrorProperties(error) ? error : undefined;
    return new ApiError(
      extendedError?.statusCode ?? 500,
      extendedError?.publicCode ?? "INTERNAL_ERROR",
      error.message,
      extendedError?.details
    );
  }

  return new ApiError(500, "INTERNAL_ERROR", "Erro interno não identificado");
};
