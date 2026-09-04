import { describe, expect, it } from "vitest";

import {
  readRealtimeServerConfig,
  RealtimeConfigurationError,
} from "@/lib/server/realtime-config";

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  AZURE_OPENAI_ENDPOINT: "https://speech-resource.openai.azure.com/",
  AZURE_OPENAI_API_KEY: "server-secret",
  AZURE_OPENAI_REALTIME_DEPLOYMENT: "gpt-realtime",
  AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT: "whisper",
  REALTIME_INSTRUCTIONS: "Be helpful.",
  APP_ORIGIN: "https://voice.example.com/",
};

describe("readRealtimeServerConfig", () => {
  it("normalizes the two configured origins", () => {
    expect(readRealtimeServerConfig(validEnvironment)).toEqual({
      endpoint: "https://speech-resource.openai.azure.com",
      apiKey: "server-secret",
      realtimeDeployment: "gpt-realtime",
      transcriptionDeployment: "whisper",
      instructions: "Be helpful.",
      appOrigin: "https://voice.example.com",
    });
  });

  it("uses safe default multilingual instructions", () => {
    const config = readRealtimeServerConfig({
      ...validEnvironment,
      REALTIME_INSTRUCTIONS: "",
    });

    expect(config.instructions).toContain("language the user speaks");
  });

  it.each([
    { AZURE_OPENAI_ENDPOINT: undefined },
    { AZURE_OPENAI_API_KEY: "" },
    { AZURE_OPENAI_ENDPOINT: "https://example.com" },
    {
      AZURE_OPENAI_ENDPOINT:
        "https://project.services.ai.azure.com/api/projects/demo",
    },
    { APP_ORIGIN: "http://voice.example.com" },
    { APP_ORIGIN: "https://voice.example.com/not-an-origin" },
  ])("rejects missing or unsafe configuration: %o", (overrides) => {
    expect(() =>
      readRealtimeServerConfig({ ...validEnvironment, ...overrides }),
    ).toThrow(RealtimeConfigurationError);
  });

  it("allows HTTP only for local development origins", () => {
    expect(
      readRealtimeServerConfig({
        ...validEnvironment,
        APP_ORIGIN: "http://localhost:3000",
      }).appOrigin,
    ).toBe("http://localhost:3000");
  });
});
