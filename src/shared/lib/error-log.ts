type SafeExternalErrorDetails = {
  name: string;
  message: string;
  statusCode: number | null;
  providerCode: string | number | null;
  providerMessage: string | null;
  responseBody: string | null;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-or-v1-[A-Za-z0-9]+/gi, "[REDACTED]");
}

function toSafeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return redactSecrets(value).slice(0, 2_000);
}

function toStatusCode(error: UnknownRecord): number | null {
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return typeof error.status === "number" ? error.status : null;
}

function toProviderCode(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function toSafeExternalErrorDetails(
  error: unknown,
): SafeExternalErrorDetails {
  if (!isRecord(error)) {
    return {
      name: "UnknownError",
      message: redactSecrets(String(error)),
      statusCode: null,
      providerCode: null,
      providerMessage: null,
      responseBody: null,
    };
  }

  const providerError = isRecord(error.error) ? error.error : {};

  return {
    name: toSafeString(error.name) || "ExternalServiceError",
    message: toSafeString(error.message) || "External service request failed",
    statusCode: toStatusCode(error),
    providerCode: toProviderCode(providerError.code),
    providerMessage: toSafeString(providerError.message),
    responseBody: toSafeString(error.body),
  };
}
