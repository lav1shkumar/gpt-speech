import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/realtime/session/route";

const offer =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const answer =
  "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const maxRequestBytes = 96 * 1024;

function sessionRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost:3000/api/realtime/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function streamedSessionRequest(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost:3000/api/realtime/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
      ...headers,
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe.sequential("POST /api/realtime/session", () => {
  beforeEach(() => {
    vi.stubEnv(
      "AZURE_OPENAI_ENDPOINT",
      "https://speech-resource.openai.azure.com",
    );
    vi.stubEnv("AZURE_OPENAI_API_KEY", "do-not-leak-this-key");
    vi.stubEnv("AZURE_OPENAI_REALTIME_DEPLOYMENT", "gpt-realtime");
    vi.stubEnv("AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT", "whisper");
    vi.stubEnv("REALTIME_INSTRUCTIONS", "Be helpful.");
    vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns only the SDP answer with non-cacheable response headers", async () => {
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: "ephemeral" }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(answer, { status: 201 }));
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await POST(
      sessionRequest({ sdp: offer, voice: "coral" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sdp: answer });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it.each([
    ["malformed JSON", "{"],
    ["unsupported voice", { sdp: offer, voice: "custom" }],
    ["malformed SDP", { sdp: "not sdp", voice: "coral" }],
    ["unknown fields", { sdp: offer, voice: "coral", apiKey: "x" }],
  ])("rejects %s before contacting Azure", async (_label, body) => {
    const upstreamFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await POST(sessionRequest(body));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatchObject({
      code: "INVALID_REQUEST",
      retryable: false,
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["without a Content-Length header", {}],
    ["with a forged small Content-Length header", { "Content-Length": "1" }],
  ])(
    "stops reading a streamed body over 96 KiB %s",
    async (_label, headers) => {
      const upstreamFetch = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", upstreamFetch);

      let pulls = 0;
      let cancelled = false;
      const chunk = new Uint8Array(32 * 1024).fill(0x20);
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(chunk);
            if (pulls === 10) {
              controller.close();
            }
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );

      const response = await POST(streamedSessionRequest(body, headers));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "INVALID_REQUEST", retryable: false },
      });
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThan(10);
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );

  it("rejects a declared body over 96 KiB before reading the stream", async () => {
    const upstreamFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstreamFetch);

    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([0x7b]));
        },
      },
      { highWaterMark: 0 },
    );

    const response = await POST(
      streamedSessionRequest(body, {
        "Content-Length": String(maxRequestBytes + 1),
      }),
    );

    expect(response.status).toBe(400);
    expect(pulls).toBe(0);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("cancels a request body that stalls before completing", async () => {
    vi.useFakeTimers();
    const upstreamFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstreamFetch);

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelled = true;
      },
    });

    const responsePromise = POST(streamedSessionRequest(body));
    await vi.advanceTimersByTimeAsync(5_001);
    const response = await responsePromise;

    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(upstreamFetch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("rejects missing, cross-site, and null origins", async () => {
    for (const origin of [undefined, "https://attacker.example", "null"]) {
      const headers = origin ? { Origin: origin } : { Origin: "" };
      const response = await POST(
        sessionRequest({ sdp: offer, voice: "coral" }, headers),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "ORIGIN_NOT_ALLOWED", retryable: false },
      });
    }
  });

  it("returns a safe error without reading or returning an upstream error body", async () => {
    const upstreamBody =
      "deployment failed with do-not-leak-this-key and provider detail";
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(upstreamBody, { status: 500 }));
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await POST(
      sessionRequest({ sdp: offer, voice: "coral" }),
    );
    const responseText = await response.text();

    expect(response.status).toBe(502);
    expect(responseText).not.toContain("do-not-leak-this-key");
    expect(responseText).not.toContain("provider detail");
    expect(responseText).not.toContain(
      "https://speech-resource.openai.azure.com",
    );
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("do-not-leak-this-key"),
    );
  });

  it("reports missing server configuration without leaking environment details", async () => {
    vi.stubEnv("AZURE_OPENAI_API_KEY", "");

    const response = await POST(
      sessionRequest({ sdp: offer, voice: "coral" }),
    );
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(responseText).toContain("AZURE_CONFIGURATION_ERROR");
    expect(responseText).not.toContain("AZURE_OPENAI_API_KEY");
  });
});
