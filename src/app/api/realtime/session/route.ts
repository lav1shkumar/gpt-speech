import { NextResponse } from "next/server";
import { z } from "zod";

import { VOICES } from "@/lib/realtime/types";
import type {
  CreateSessionErrorResponse,
  CreateSessionResponse,
  VoiceId,
} from "@/lib/realtime/types";
import { negotiateAzureRealtimeSession } from "@/lib/server/azure-realtime";
import {
  readRealtimeServerConfig,
  RealtimeConfigurationError,
} from "@/lib/server/realtime-config";
import {
  configurationError,
  internalError,
  invalidRequestError,
  originNotAllowedError,
  SessionBrokerError,
} from "@/lib/server/session-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 96 * 1024;
const REQUEST_BODY_TIMEOUT_MS = 5_000;
const MAX_SDP_LENGTH = 131_072;
const voiceIds = VOICES.map(({ id }) => id) as [VoiceId, ...VoiceId[]];

export const createSessionRequestSchema = z
  .object({
    sdp: z
      .string()
      .min(1)
      .max(MAX_SDP_LENGTH)
      .refine((value) => {
        const normalized = value.replaceAll("\r\n", "\n");
        return (
          normalized.startsWith("v=0\n") &&
          normalized.includes("\nm=audio ") &&
          !normalized.includes("\0")
        );
      }),
    voice: z.enum(voiceIds),
  })
  .strict();

function noStoreHeaders(requestId: string): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
  };
}

function logResult(
  requestId: string,
  startedAt: number,
  statusCode: number,
  errorCode?: string,
) {
  const entry = {
    event: "realtime_session",
    requestId,
    durationMs: Date.now() - startedAt,
    statusCode,
    ...(errorCode ? { errorCode } : {}),
  };

  if (statusCode >= 500) {
    console.error(JSON.stringify(entry));
  } else {
    console.info(JSON.stringify(entry));
  }
}

function errorResponse(
  error: SessionBrokerError,
  requestId: string,
  startedAt: number,
) {
  const body: CreateSessionErrorResponse = {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requestId,
    },
  };

  logResult(requestId, startedAt, error.status, error.code);
  return NextResponse.json(body, {
    status: error.status,
    headers: noStoreHeaders(requestId),
  });
}

async function parseRequestBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.split(";", 1)[0]?.trim() !== "application/json") {
    throw invalidRequestError();
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    (contentLength < 0 || contentLength > MAX_REQUEST_BYTES)
  ) {
    throw invalidRequestError();
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw invalidRequestError();
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytesRead = 0;
  let rejectBodyDeadline: (reason: SessionBrokerError) => void;
  const bodyDeadline = new Promise<never>((_resolve, reject) => {
    rejectBodyDeadline = reject;
  });
  const bodyTimeout = setTimeout(() => {
    rejectBodyDeadline(invalidRequestError());
  }, REQUEST_BODY_TIMEOUT_MS);
  bodyTimeout.unref?.();

  try {
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        bodyDeadline,
      ]);
      if (done) {
        break;
      }

      bytesRead += value.byteLength;
      if (bytesRead > MAX_REQUEST_BYTES) {
        throw invalidRequestError();
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be errored or closed.
    }

    if (error instanceof SessionBrokerError) {
      throw error;
    }

    throw invalidRequestError();
  } finally {
    clearTimeout(bodyTimeout);
    reader.releaseLock();
  }

  try {
    return JSON.parse(chunks.join("")) as unknown;
  } catch {
    throw invalidRequestError();
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const config = readRealtimeServerConfig();
    if (request.headers.get("origin") !== config.appOrigin) {
      throw originNotAllowedError();
    }

    const parsed = createSessionRequestSchema.safeParse(
      await parseRequestBody(request),
    );
    if (!parsed.success) {
      throw invalidRequestError();
    }

    const sdp = await negotiateAzureRealtimeSession(config, parsed.data, {
      signal: request.signal,
    });
    const body: CreateSessionResponse = { sdp };

    logResult(requestId, startedAt, 200);
    return NextResponse.json(body, {
      status: 200,
      headers: noStoreHeaders(requestId),
    });
  } catch (error) {
    if (error instanceof SessionBrokerError) {
      return errorResponse(error, requestId, startedAt);
    }

    if (error instanceof RealtimeConfigurationError) {
      return errorResponse(configurationError(), requestId, startedAt);
    }

    return errorResponse(internalError(), requestId, startedAt);
  }
}
