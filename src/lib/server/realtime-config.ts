import { z } from "zod";

const DEFAULT_INSTRUCTIONS =
  "You are a helpful, concise voice assistant. Reply naturally in the language the user speaks unless they ask you to switch languages.";

const rawEnvironmentSchema = z.object({
  AZURE_OPENAI_ENDPOINT: z.string().trim().min(1),
  AZURE_OPENAI_API_KEY: z.string().trim().min(1),
  AZURE_OPENAI_REALTIME_DEPLOYMENT: z.string().trim().min(1).max(128),
  AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT: z
    .string()
    .trim()
    .min(1)
    .max(128),
  REALTIME_INSTRUCTIONS: z.string().trim().max(16_384).optional(),
  APP_ORIGIN: z.string().trim().min(1),
});

export type RealtimeServerConfig = {
  endpoint: string;
  apiKey: string;
  realtimeDeployment: string;
  transcriptionDeployment: string;
  instructions: string;
  appOrigin: string;
};

export class RealtimeConfigurationError extends Error {
  constructor() {
    super("The realtime service is not configured correctly.");
    this.name = "RealtimeConfigurationError";
  }
}

function parseAzureEndpoint(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new RealtimeConfigurationError();
  }

  const isAzureOpenAIHost =
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openai\.azure\.com$/i.test(
      url.hostname,
    );

  if (
    url.protocol !== "https:" ||
    !isAzureOpenAIHost ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new RealtimeConfigurationError();
  }

  return url.origin;
}

function parseAppOrigin(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new RealtimeConfigurationError();
  }

  const isLocalDevelopmentOrigin =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");

  if (
    (url.protocol !== "https:" && !isLocalDevelopmentOrigin) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new RealtimeConfigurationError();
  }

  return url.origin;
}

export function readRealtimeServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RealtimeServerConfig {
  const parsed = rawEnvironmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new RealtimeConfigurationError();
  }

  return {
    endpoint: parseAzureEndpoint(parsed.data.AZURE_OPENAI_ENDPOINT),
    apiKey: parsed.data.AZURE_OPENAI_API_KEY,
    realtimeDeployment: parsed.data.AZURE_OPENAI_REALTIME_DEPLOYMENT,
    transcriptionDeployment:
      parsed.data.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT,
    instructions:
      parsed.data.REALTIME_INSTRUCTIONS || DEFAULT_INSTRUCTIONS,
    appOrigin: parseAppOrigin(parsed.data.APP_ORIGIN),
  };
}
