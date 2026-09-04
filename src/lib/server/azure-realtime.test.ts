import { afterEach, describe, expect, it, vi } from "vitest";

import { negotiateAzureRealtimeSession } from "@/lib/server/azure-realtime";
import type { RealtimeServerConfig } from "@/lib/server/realtime-config";

const config: RealtimeServerConfig = {
  endpoint: "https://speech-resource.openai.azure.com",
  apiKey: "permanent-api-key",
  realtimeDeployment: "realtime-deployment",
  transcriptionDeployment: "transcription-deployment",
  instructions: "Speak naturally.",
  appOrigin: "https://voice.example.com",
};

const offer =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const answer =
  "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

describe("negotiateAzureRealtimeSession", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a server-owned session and proxies SDP without exposing the API key", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: "ephemeral-client-secret" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(answer, {
          status: 201,
          headers: { "Content-Type": "application/sdp" },
        }),
      );

    await expect(
      negotiateAzureRealtimeSession(
        config,
        { sdp: offer, voice: "coral" },
        { fetchImplementation },
      ),
    ).resolves.toBe(answer);

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const [secretUrl, secretInit] = fetchImplementation.mock.calls[0];
    expect(secretUrl).toBe(
      "https://speech-resource.openai.azure.com/openai/v1/realtime/client_secrets",
    );
    expect(secretInit?.headers).toMatchObject({
      "api-key": "permanent-api-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(secretInit?.body))).toEqual({
      session: {
        type: "realtime",
        model: "realtime-deployment",
        instructions: "Speak naturally.",
        audio: {
          input: {
            transcription: { model: "transcription-deployment" },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { voice: "coral" },
        },
      },
    });

    const [callsUrl, callsInit] = fetchImplementation.mock.calls[1];
    expect(callsUrl).toBe(
      "https://speech-resource.openai.azure.com/openai/v1/realtime/calls?webrtcfilter=on",
    );
    expect(callsInit?.headers).toMatchObject({
      Authorization: "Bearer ephemeral-client-secret",
      "Content-Type": "application/sdp",
    });
    expect(callsInit?.body).toBe(offer);
    expect(JSON.stringify(callsInit)).not.toContain("permanent-api-key");
  });

  it("maps client-secret authentication failures to a safe configuration error", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("permanent-api-key: invalid", { status: 401 }),
      );

    const result = negotiateAzureRealtimeSession(
      config,
      { sdp: offer, voice: "coral" },
      { fetchImplementation },
    );

    await expect(result).rejects.toMatchObject({
      code: "AZURE_CONFIGURATION_ERROR",
      status: 503,
      retryable: false,
    });
    await expect(result).rejects.not.toThrow(/permanent-api-key/);
  });

  it("rejects malformed successful upstream responses", async () => {
    const malformedSecretFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ value: "" })));

    await expect(
      negotiateAzureRealtimeSession(
        config,
        { sdp: offer, voice: "coral" },
        { fetchImplementation: malformedSecretFetch },
      ),
    ).rejects.toMatchObject({ code: "AZURE_UNAVAILABLE" });

    const malformedSdpFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: "ephemeral" }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("not an SDP answer", { status: 201 }));

    await expect(
      negotiateAzureRealtimeSession(
        config,
        { sdp: offer, voice: "coral" },
        { fetchImplementation: malformedSdpFetch },
      ),
    ).rejects.toMatchObject({ code: "AZURE_UNAVAILABLE" });
  });

  it("turns an upstream timeout into a retryable timeout error", async () => {
    vi.useFakeTimers();
    const fetchImplementation = vi.fn<typeof fetch>((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const result = negotiateAzureRealtimeSession(
      config,
      { sdp: offer, voice: "coral" },
      { fetchImplementation },
    );
    const assertion = expect(result).rejects.toMatchObject({
      code: "NEGOTIATION_TIMEOUT",
      status: 504,
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
  });

  it("keeps the timeout active while reading the client-secret body", async () => {
    vi.useFakeTimers();
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      return {
        ok: true,
        status: 200,
        json: () => new Promise<never>(() => undefined),
      } as unknown as Response;
    });

    const result = negotiateAzureRealtimeSession(
      config,
      { sdp: offer, voice: "coral" },
      { fetchImplementation },
    );
    const assertion = expect(result).rejects.toMatchObject({
      code: "NEGOTIATION_TIMEOUT",
      status: 504,
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeout active while reading the SDP answer body", async () => {
    vi.useFakeTimers();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: "ephemeral" }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: () => new Promise<never>(() => undefined),
      } as unknown as Response);

    const result = negotiateAzureRealtimeSession(
      config,
      { sdp: offer, voice: "coral" },
      { fetchImplementation },
    );
    const assertion = expect(result).rejects.toMatchObject({
      code: "NEGOTIATION_TIMEOUT",
      status: 504,
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});
