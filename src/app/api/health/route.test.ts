import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/health/route";

function configureEnvironment() {
  vi.stubEnv(
    "AZURE_OPENAI_ENDPOINT",
    "https://speech-resource.openai.azure.com",
  );
  vi.stubEnv("AZURE_OPENAI_API_KEY", "secret");
  vi.stubEnv("AZURE_OPENAI_REALTIME_DEPLOYMENT", "gpt-realtime");
  vi.stubEnv("AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT", "whisper");
  vi.stubEnv("APP_ORIGIN", "https://voice.example.com");
}

describe.sequential("GET /api/health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports readiness without returning configuration values", async () => {
    configureEnvironment();

    const response = GET();
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(responseText)).toEqual({
      status: "ok",
      checks: { azureOpenAI: "configured" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(responseText).not.toContain("secret");
    expect(responseText).not.toContain("speech-resource");
  });

  it("returns 503 when required configuration is missing", async () => {
    configureEnvironment();
    vi.stubEnv("AZURE_OPENAI_REALTIME_DEPLOYMENT", "");

    const response = GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      checks: { azureOpenAI: "not_configured" },
    });
  });
});

