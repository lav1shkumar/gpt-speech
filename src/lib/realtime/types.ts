export const VOICES = [
  { id: "alloy", label: "Alloy", description: "Balanced and versatile" },
  { id: "ash", label: "Ash", description: "Calm and measured" },
  { id: "ballad", label: "Ballad", description: "Warm and expressive" },
  { id: "coral", label: "Coral", description: "Clear and friendly" },
  { id: "echo", label: "Echo", description: "Smooth and direct" },
  { id: "sage", label: "Sage", description: "Thoughtful and composed" },
  { id: "shimmer", label: "Shimmer", description: "Bright and upbeat" },
  { id: "verse", label: "Verse", description: "Natural and conversational" },
] as const;

export type VoiceId = (typeof VOICES)[number]["id"];

export type ConnectionState =
  | "idle"
  | "requesting-microphone"
  | "negotiating"
  | "connected"
  | "disconnecting"
  | "error";

export type ActivityState =
  | "listening"
  | "user-speaking"
  | "assistant-thinking"
  | "assistant-speaking";

export type TranscriptTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "streaming" | "complete" | "interrupted";
};

export type RealtimeErrorKind =
  | "unsupported-browser"
  | "insecure-context"
  | "microphone-denied"
  | "microphone-missing"
  | "microphone-unavailable"
  | "autoplay-blocked"
  | "offline"
  | "connection-failed"
  | "service-error";

export type RealtimeError = {
  kind: RealtimeErrorKind;
  message: string;
  retryable: boolean;
};

export type DiagnosticEntry = {
  id: string;
  at: string;
  type: string;
  detail?: string;
};

export type CreateSessionRequest = {
  sdp: string;
  voice: VoiceId;
};

export type CreateSessionResponse = {
  sdp: string;
};

export type SessionErrorCode =
  | "INVALID_REQUEST"
  | "ORIGIN_NOT_ALLOWED"
  | "AZURE_CONFIGURATION_ERROR"
  | "AZURE_UNAVAILABLE"
  | "NEGOTIATION_TIMEOUT"
  | "INTERNAL_ERROR";

export type CreateSessionErrorResponse = {
  error: {
    code: SessionErrorCode;
    message: string;
    retryable: boolean;
    requestId: string;
  };
};
