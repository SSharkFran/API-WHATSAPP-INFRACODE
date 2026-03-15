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

/**
 * Converte erros desconhecidos para um formato consistente de resposta HTTP.
 */
export const normalizeError = (error: unknown): ApiError => {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof Error) {
    return new ApiError(error.statusCode ?? 500, error.publicCode ?? "INTERNAL_ERROR", error.message, error.details);
  }

  return new ApiError(500, "INTERNAL_ERROR", "Erro interno não identificado");
};
