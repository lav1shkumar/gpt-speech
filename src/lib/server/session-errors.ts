import type { SessionErrorCode } from "@/lib/realtime/types";

type SessionBrokerErrorOptions = {
  code: SessionErrorCode;
  status: number;
  message: string;
  retryable: boolean;
};

export class SessionBrokerError extends Error {
  readonly code: SessionErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(options: SessionBrokerErrorOptions) {
    super(options.message);
    this.name = "SessionBrokerError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

export function invalidRequestError(): SessionBrokerError {
  return new SessionBrokerError({
    code: "INVALID_REQUEST",
    status: 400,
    message: "The session request is invalid.",
    retryable: false,
  });
}

export function originNotAllowedError(): SessionBrokerError {
  return new SessionBrokerError({
    code: "ORIGIN_NOT_ALLOWED",
    status: 403,
    message: "This origin is not allowed to create realtime sessions.",
    retryable: false,
  });
}

export function configurationError(): SessionBrokerError {
  return new SessionBrokerError({
    code: "AZURE_CONFIGURATION_ERROR",
    status: 503,
    message: "The realtime service is not configured correctly.",
    retryable: false,
  });
}

export function azureUnavailableError(): SessionBrokerError {
  return new SessionBrokerError({
    code: "AZURE_UNAVAILABLE",
    status: 502,
    message: "The realtime service is temporarily unavailable.",
    retryable: true,
  });
}

export function negotiationTimeoutError(): SessionBrokerError {
  return new SessionBrokerError({
    code: "NEGOTIATION_TIMEOUT",
    status: 504,
    message: "Realtime session negotiation timed out.",
    retryable: true,
  });
}

export function internalError(): SessionBrokerError {
  return new SessionBrokerError({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "The session could not be created.",
    retryable: true,
  });
}
