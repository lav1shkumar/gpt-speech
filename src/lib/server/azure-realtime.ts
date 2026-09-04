import { z } from "zod";

import type { VoiceId } from "@/lib/realtime/types";
import type { RealtimeServerConfig } from "@/lib/server/realtime-config";
import {
  azureUnavailableError,
  configurationError,
  negotiationTimeoutError,
  SessionBrokerError,
} from "@/lib/server/session-errors";

const CLIENT_SECRET_TIMEOUT_MS = 12_000;
const SDP_NEGOTIATION_TIMEOUT_MS = 15_000;
const MAX_SDP_ANSWER_LENGTH = 131_072;

const clientSecretSchema = z.object({
  value: z.string().min(1),
});

type FetchImplementation = typeof fetch;

type NegotiateSessionOptions = {
  fetchImplementation?: FetchImplementation;
  signal?: AbortSignal;
};

function isSdp(value: string): boolean {
  const normalized = value.replaceAll("\r\n", "\n");
  return (
    normalized.startsWith("v=0\n") &&
    normalized.includes("\nm=audio ") &&
    !normalized.includes("\0")
  );
}

function timeoutSignal(timeoutMs: number, parentSignal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let rejectOnTimeout: (reason: SessionBrokerError) => void;

  const expiration = new Promise<never>((_resolve, reject) => {
    rejectOnTimeout = reject;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectOnTimeout(negotiationTimeoutError());
  }, timeoutMs);
  timeout.unref?.();

  const abortFromParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (parentSignal?.aborted) {
    abortFromParent();
  }

  return {
    signal: controller.signal,
    expiration,
    didTimeOut: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function fetchWithTimeout<T>(
  fetchImplementation: FetchImplementation,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T> | T,
  parentSignal?: AbortSignal,
): Promise<T> {
  const timeout = timeoutSignal(timeoutMs, parentSignal);

  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImplementation(url, {
          ...init,
          cache: "no-store",
          redirect: "error",
          signal: timeout.signal,
        });

        return consume(response);
      })(),
      timeout.expiration,
    ]);
  } catch (error) {
    if (timeout.didTimeOut()) {
      throw negotiationTimeoutError();
    }

    if (error instanceof SessionBrokerError) {
      throw error;
    }

    throw azureUnavailableError();
  } finally {
    timeout.dispose();
  }
}

function sessionConfiguration(config: RealtimeServerConfig, voice: VoiceId) {
  return {
    session: {
      type: "realtime",
      model: config.realtimeDeployment,
      instructions: config.instructions,
      audio: {
        input: {
          transcription: {
            model: config.transcriptionDeployment,
          },
          turn_detection: {
            type: "server_vad",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          voice,
        },
      },
    },
  } as const;
}

async function createClientSecret(
  config: RealtimeServerConfig,
  voice: VoiceId,
  fetchImplementation: FetchImplementation,
  signal?: AbortSignal,
): Promise<string> {
  return fetchWithTimeout(
    fetchImplementation,
    `${config.endpoint}/openai/v1/realtime/client_secrets`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "api-key": config.apiKey,
      },
      body: JSON.stringify(sessionConfiguration(config, voice)),
    },
    CLIENT_SECRET_TIMEOUT_MS,
    async (response) => {
      if (!response.ok) {
        if ([400, 401, 403, 404].includes(response.status)) {
          throw configurationError();
        }

        throw azureUnavailableError();
      }

      const payload: unknown = await response.json();
      const parsed = clientSecretSchema.safeParse(payload);
      if (!parsed.success) {
        throw azureUnavailableError();
      }

      return parsed.data.value;
    },
    signal,
  );
}

export async function negotiateAzureRealtimeSession(
  config: RealtimeServerConfig,
  input: { sdp: string; voice: VoiceId },
  options: NegotiateSessionOptions = {},
): Promise<string> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const ephemeralSecret = await createClientSecret(
    config,
    input.voice,
    fetchImplementation,
    options.signal,
  );

  return fetchWithTimeout(
    fetchImplementation,
    `${config.endpoint}/openai/v1/realtime/calls?webrtcfilter=on`,
    {
      method: "POST",
      headers: {
        Accept: "application/sdp",
        Authorization: `Bearer ${ephemeralSecret}`,
        "Content-Type": "application/sdp",
      },
      body: input.sdp,
    },
    SDP_NEGOTIATION_TIMEOUT_MS,
    async (response) => {
      if (!response.ok) {
        throw azureUnavailableError();
      }

      const answer = await response.text();
      if (answer.length > MAX_SDP_ANSWER_LENGTH || !isSdp(answer)) {
        throw azureUnavailableError();
      }

      return answer;
    },
    options.signal,
  );
}
