"use client";

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  createInitialRealtimeEventState,
  getRealtimeEventType,
  getRealtimeProtocolIssue,
  realtimeEventReducer,
} from "@/lib/realtime/events";
import type {
  RealtimeEventAction,
  RealtimeEventState,
} from "@/lib/realtime/events";
import {
  prepareConversationHistory,
  type PreparedConversationHistory,
} from "@/lib/realtime/history";
import type {
  ActivityState,
  ConnectionState,
  CreateSessionResponse,
  DiagnosticEntry,
  RealtimeError,
  TranscriptTurn,
  VoiceId,
} from "@/lib/realtime/types";

export const DISCONNECTED_GRACE_MS = 5_000;
export const CONNECTION_ESTABLISHMENT_TIMEOUT_MS = 20_000;

export type UseRealtimeSessionResult = {
  connectionState: ConnectionState;
  activityState: ActivityState;
  transcript: TranscriptTurn[];
  isMuted: boolean;
  needsAudioResume: boolean;
  error: RealtimeError | null;
  diagnostics: DiagnosticEntry[];
  start: (voice: VoiceId, priorTurns?: TranscriptTurn[]) => Promise<void>;
  stop: () => void;
  toggleMute: () => void;
  resumeAudio: () => Promise<void>;
  restoreTranscript: (turns: TranscriptTurn[]) => void;
  clearTranscript: () => void;
};

type SessionStartError = Error & { realtimeError: RealtimeError };

const AUTOPLAY_ERROR: RealtimeError = {
  kind: "autoplay-blocked",
  message: "Tap Resume audio to hear the assistant.",
  retryable: true,
};

type SessionEventAction =
  | RealtimeEventAction
  | {
      type: "restore-transcript";
      history: PreparedConversationHistory;
    };

function sessionEventReducer(
  state: RealtimeEventState,
  action: SessionEventAction,
): RealtimeEventState {
  if (action.type === "restore-transcript") {
    return {
      ...createInitialRealtimeEventState(),
      transcript: action.history.transcript,
      conversationItems: action.history.conversationItems,
    };
  }

  return realtimeEventReducer(state, action);
}

function createSessionStartError(realtimeError: RealtimeError): SessionStartError {
  return Object.assign(new Error(realtimeError.message), { realtimeError });
}

function errorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return null;
  }

  return typeof error.name === "string" ? error.name : null;
}

function microphoneError(error: unknown): RealtimeError {
  switch (errorName(error)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return {
        kind: "microphone-denied",
        message:
          "Microphone access was denied. Allow access in your browser settings and try again.",
        retryable: true,
      };

    case "NotFoundError":
    case "DevicesNotFoundError":
      return {
        kind: "microphone-missing",
        message: "No microphone was found. Connect one and try again.",
        retryable: true,
      };

    default:
      return {
        kind: "microphone-unavailable",
        message: "The microphone is unavailable. Close other audio apps and try again.",
        retryable: true,
      };
  }
}

function negotiationError(status: number, body: unknown): RealtimeError {
  let code: string | null = null;
  let retryable = status === 429 || status >= 500;

  if (typeof body === "object" && body !== null && "error" in body) {
    const nested = body.error;
    if (typeof nested === "object" && nested !== null) {
      if ("code" in nested && typeof nested.code === "string") {
        code = nested.code;
      }
      if ("retryable" in nested && typeof nested.retryable === "boolean") {
        retryable = nested.retryable;
      }
    }
  }

  if (code === "AZURE_CONFIGURATION_ERROR") {
    return {
      kind: "service-error",
      message: "The voice service is not configured. Contact the app owner.",
      retryable: false,
    };
  }

  if (code === "ORIGIN_NOT_ALLOWED") {
    return {
      kind: "connection-failed",
      message: "This site is not allowed to start a voice session.",
      retryable: false,
    };
  }

  if (
    code === "AZURE_UNAVAILABLE" ||
    code === "NEGOTIATION_TIMEOUT" ||
    status === 429 ||
    status >= 500
  ) {
    return {
      kind: "service-error",
      message: "The voice service is temporarily unavailable. Try again shortly.",
      retryable: true,
    };
  }

  return {
    kind: "connection-failed",
    message: "The voice session could not be started. Please try again.",
    retryable,
  };
}

function connectionError(): RealtimeError {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return {
      kind: "offline",
      message: "You appear to be offline. Reconnect and try again.",
      retryable: true,
    };
  }

  return {
    kind: "connection-failed",
    message: "The voice connection was lost. End the call and try again.",
    retryable: true,
  };
}

function isSessionResponse(value: unknown): value is CreateSessionResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "sdp" in value &&
    typeof value.sdp === "string" &&
    value.sdp.length > 0
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

function acknowledgedConversationItemId(event: unknown): string | null {
  const record = asRecord(event);
  if (
    record?.type !== "conversation.item.added" &&
    record?.type !== "conversation.item.created"
  ) {
    return null;
  }

  const item = asRecord(record.item);
  return item && typeof item.id === "string" ? item.id : null;
}

function replayErrorClientEventId(event: unknown): string | null {
  const record = asRecord(event);
  if (record?.type !== "error") {
    return null;
  }

  const error = asRecord(record.error);
  if (error && typeof error.event_id === "string") {
    return error.event_id;
  }

  // Some Realtime-compatible endpoints put the triggering client event ID at
  // the top level. The caller still verifies it against the replay ID set.
  return typeof record.event_id === "string" ? record.event_id : null;
}

export function useRealtimeSession(): UseRealtimeSessionResult {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const [eventState, dispatchEvent] = useReducer(
    sessionEventReducer,
    undefined,
    createInitialRealtimeEventState,
  );
  const [isMuted, setIsMuted] = useState(false);
  const [needsAudioResume, setNeedsAudioResume] = useState(false);
  const [error, setError] = useState<RealtimeError | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const disconnectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const diagnosticIdRef = useRef(0);
  const mountedRef = useRef(true);

  const addDiagnostic = useCallback((type: string, detail?: string) => {
    if (process.env.NODE_ENV === "production" || !mountedRef.current) {
      return;
    }

    const entry: DiagnosticEntry = {
      id: String(++diagnosticIdRef.current),
      at: new Date().toISOString(),
      type,
      ...(detail ? { detail } : {}),
    };
    setDiagnostics((current) => [...current.slice(-39), entry]);
  }, []);

  const clearDisconnectedTimer = useCallback(() => {
    if (disconnectedTimerRef.current !== null) {
      clearTimeout(disconnectedTimerRef.current);
      disconnectedTimerRef.current = null;
    }
  }, []);

  const clearConnectionTimer = useCallback(() => {
    if (connectionTimerRef.current !== null) {
      clearTimeout(connectionTimerRef.current);
      connectionTimerRef.current = null;
    }
  }, []);

  const cleanupResources = useCallback(() => {
    clearDisconnectedTimer();
    clearConnectionTimer();

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    const channel = dataChannelRef.current;
    dataChannelRef.current = null;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onmessage = null;
      if (channel.readyState !== "closed") {
        try {
          channel.close();
        } catch {
          // The channel may already be closing in another browser task.
        }
      }
    }

    const peerConnection = peerConnectionRef.current;
    peerConnectionRef.current = null;
    if (peerConnection) {
      peerConnection.onconnectionstatechange = null;
      peerConnection.ontrack = null;
      try {
        peerConnection.close();
      } catch {
        // Closing an already-closed peer is safe to ignore.
      }
    }

    const microphoneStream = microphoneStreamRef.current;
    microphoneStreamRef.current = null;
    microphoneStream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });

    const remoteAudio = remoteAudioRef.current;
    remoteAudioRef.current = null;
    if (remoteAudio) {
      try {
        remoteAudio.pause();
      } catch {
        // Some test/browser audio implementations do not implement pause.
      }
      remoteAudio.srcObject = null;
    }
  }, [clearConnectionTimer, clearDisconnectedTimer]);

  const failSession = useCallback(
    (generation: number, nextError: RealtimeError) => {
      if (
        generationRef.current !== generation ||
        !mountedRef.current
      ) {
        return;
      }

      generationRef.current += 1;
      addDiagnostic("session.failed", nextError.kind);
      cleanupResources();
      dispatchEvent({ type: "session-stopped" });
      setNeedsAudioResume(false);
      setIsMuted(false);
      setError(nextError);
      setConnectionState("error");
    },
    [addDiagnostic, cleanupResources],
  );

  const playRemoteAudio = useCallback(
    async (generation: number): Promise<boolean> => {
      const audio = remoteAudioRef.current;
      if (!audio || generationRef.current !== generation) {
        return false;
      }

      try {
        await audio.play();
        if (generationRef.current !== generation || !mountedRef.current) {
          return false;
        }
        setNeedsAudioResume(false);
        setError((current) =>
          current?.kind === "autoplay-blocked" ? null : current,
        );
        return true;
      } catch {
        if (generationRef.current !== generation || !mountedRef.current) {
          return false;
        }
        addDiagnostic("audio.autoplay-blocked");
        setNeedsAudioResume(true);
        setError(AUTOPLAY_ERROR);
        return false;
      }
    },
    [addDiagnostic],
  );

  const start = useCallback(
    async (voice: VoiceId, priorTurns?: TranscriptTurn[]): Promise<void> => {
      const generation = generationRef.current + 1;
      const history = prepareConversationHistory(priorTurns);
      generationRef.current = generation;
      cleanupResources();

      dispatchEvent({ type: "restore-transcript", history });
      setError(null);
      setNeedsAudioResume(false);
      setIsMuted(false);
      setDiagnostics([]);

      if (
        typeof window === "undefined" ||
        typeof navigator === "undefined" ||
        typeof window.RTCPeerConnection === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        failSession(generation, {
          kind: "unsupported-browser",
          message: "This browser does not support WebRTC voice conversations.",
          retryable: false,
        });
        return;
      }

      if (window.isSecureContext === false) {
        failSession(generation, {
          kind: "insecure-context",
          message: "Microphone access requires a secure HTTPS connection.",
          retryable: false,
        });
        return;
      }

      if (navigator.onLine === false) {
        failSession(generation, connectionError());
        return;
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      setConnectionState("requesting-microphone");
      addDiagnostic("session.start", voice);

      let microphoneStream: MediaStream;
      try {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
          video: false,
        });
      } catch (cause) {
        if (generationRef.current === generation) {
          failSession(generation, microphoneError(cause));
        }
        return;
      }

      if (
        generationRef.current !== generation ||
        !mountedRef.current
      ) {
        microphoneStream.getTracks().forEach((track) => track.stop());
        return;
      }

      microphoneStreamRef.current = microphoneStream;
      addDiagnostic("microphone.ready");

      try {
        const peerConnection = new window.RTCPeerConnection();
        peerConnectionRef.current = peerConnection;

        const remoteAudio = new Audio();
        remoteAudio.autoplay = true;
        remoteAudio.setAttribute("playsinline", "");
        remoteAudioRef.current = remoteAudio;

        const dataChannel = peerConnection.createDataChannel("oai-events");
        dataChannelRef.current = dataChannel;

        const isCurrent = () =>
          generationRef.current === generation && mountedRef.current;
        const replayEventIds = new Set(
          history.replayEvents.map((event) => event.event_id),
        );
        const finalReplayItemId =
          history.replayEvents.at(-1)?.item.id ?? null;
        let replayState:
          | "not-needed"
          | "pending"
          | "awaiting-ack"
          | "acknowledged"
          | "failed" = finalReplayItemId ? "pending" : "not-needed";
        let noHistoryDiagnosticAdded = false;
        let microphoneGated = finalReplayItemId !== null;

        const replayHistoryIfNeeded = (): boolean => {
          if (replayState === "not-needed") {
            if (!noHistoryDiagnosticAdded) {
              noHistoryDiagnosticAdded = true;
              addDiagnostic("history.replay-skipped", "no-history");
            }
            return true;
          }

          if (replayState === "acknowledged") {
            return true;
          }

          if (replayState !== "pending") {
            return false;
          }

          replayState = "awaiting-ack";
          try {
            history.replayEvents.forEach((event) => {
              dataChannel.send(JSON.stringify(event));
            });
          } catch {
            replayState = "failed";
            addDiagnostic("history.replay-failed");
            failSession(generation, {
              kind: "connection-failed",
              message:
                "The saved conversation could not be restored. Please try again.",
              retryable: true,
            });
            return false;
          }

          addDiagnostic(
            "history.replayed",
            `${history.replayEvents.length} turns, ${history.replayCharacterCount} characters`,
          );
          return false;
        };

        const markConnectedIfReady = (): boolean => {
          if (
            !isCurrent() ||
            peerConnection.connectionState !== "connected" ||
            dataChannel.readyState !== "open"
          ) {
            return false;
          }

          if (!replayHistoryIfNeeded()) {
            return false;
          }

          if (microphoneGated) {
            microphoneStream.getAudioTracks().forEach((track) => {
              track.enabled = true;
            });
            microphoneGated = false;
            addDiagnostic("microphone.replay-gate-opened");
          }

          clearConnectionTimer();
          clearDisconnectedTimer();
          setConnectionState("connected");
          return true;
        };

        dataChannel.onopen = () => {
          if (!isCurrent()) return;
          addDiagnostic("data-channel.open");
          markConnectedIfReady();
        };

        dataChannel.onmessage = (messageEvent) => {
          if (!isCurrent() || typeof messageEvent.data !== "string") {
            return;
          }

          let serverEvent: unknown;
          try {
            serverEvent = JSON.parse(messageEvent.data) as unknown;
          } catch {
            addDiagnostic("protocol.invalid-message");
            return;
          }

          const replayErrorEventId = replayErrorClientEventId(serverEvent);
          if (
            replayState !== "not-needed" &&
            replayState !== "failed" &&
            replayErrorEventId &&
            replayEventIds.has(replayErrorEventId)
          ) {
            replayState = "failed";
            addDiagnostic("history.replay-rejected", replayErrorEventId);
            failSession(generation, {
              kind: "connection-failed",
              message:
                "The saved conversation could not be restored. Please try again.",
              retryable: true,
            });
            return;
          }

          const eventType = getRealtimeEventType(serverEvent);
          if (
            eventType &&
            eventType.length <= 80 &&
            /^[a-z0-9_.-]+$/i.test(eventType)
          ) {
            addDiagnostic("protocol.event", eventType);
          }

          dispatchEvent({ type: "server-event", event: serverEvent });

          const acknowledgedItemId =
            acknowledgedConversationItemId(serverEvent);
          if (
            replayState === "awaiting-ack" &&
            acknowledgedItemId !== null &&
            acknowledgedItemId === finalReplayItemId
          ) {
            replayState = "acknowledged";
            addDiagnostic("history.replay-acknowledged", acknowledgedItemId);
            markConnectedIfReady();
          }

          const issue = getRealtimeProtocolIssue(serverEvent);
          if (issue === "transcription-failed") {
            setError({
              kind: "service-error",
              message:
                "Your last turn could not be transcribed. The audio conversation can continue.",
              retryable: true,
            });
          } else if (issue === "service-error") {
            setError({
              kind: "service-error",
              message:
                "The voice service reported an error. End the call and try again.",
              retryable: true,
            });
          }
        };

        dataChannel.onerror = () => {
          if (!isCurrent()) return;
          addDiagnostic("data-channel.error");
          setError({
            kind: "connection-failed",
            message: "Live transcript updates are unavailable for this call.",
            retryable: true,
          });
        };

        dataChannel.onclose = () => {
          if (!isCurrent()) return;
          failSession(generation, connectionError());
        };

        peerConnection.ontrack = (trackEvent) => {
          if (!isCurrent()) return;

          const remoteStream = trackEvent.streams[0];
          remoteAudio.srcObject =
            remoteStream ?? new MediaStream([trackEvent.track]);
          void playRemoteAudio(generation);
        };

        peerConnection.onconnectionstatechange = () => {
          if (!isCurrent()) return;

          const state = peerConnection.connectionState;
          addDiagnostic("peer.connection-state", state);

          if (state === "connected") {
            clearDisconnectedTimer();
            markConnectedIfReady();
            return;
          }

          if (state === "disconnected") {
            clearDisconnectedTimer();
            disconnectedTimerRef.current = setTimeout(() => {
              disconnectedTimerRef.current = null;
              if (
                isCurrent() &&
                peerConnection.connectionState === "disconnected"
              ) {
                failSession(generation, connectionError());
              }
            }, DISCONNECTED_GRACE_MS);
            return;
          }

          if (state === "failed") {
            failSession(generation, connectionError());
            return;
          }

          if (state === "closed") {
            failSession(generation, connectionError());
          }
        };

        microphoneStream.getAudioTracks().forEach((track) => {
          if (microphoneGated) {
            track.enabled = false;
          }
          track.onended = () => {
            if (!isCurrent()) return;
            addDiagnostic("microphone.ended");
            failSession(generation, {
              kind: "microphone-unavailable",
              message:
                "The microphone was disconnected or became unavailable. Check it and try again.",
              retryable: true,
            });
          };
          peerConnection.addTrack(track, microphoneStream);
        });

        setConnectionState("negotiating");
        connectionTimerRef.current = setTimeout(() => {
          connectionTimerRef.current = null;
          if (!isCurrent()) {
            return;
          }

          const connected = markConnectedIfReady();
          if (!connected && isCurrent()) {
            addDiagnostic(
              replayState === "awaiting-ack"
                ? "history.replay-timeout"
                : dataChannel.readyState === "open"
                ? "session.connection-timeout"
                : "data-channel.open-timeout",
            );
            failSession(generation, {
              kind: "connection-failed",
              message: "The voice connection timed out. Please try again.",
              retryable: true,
            });
          }
        }, CONNECTION_ESTABLISHMENT_TIMEOUT_MS);
        const offer = await peerConnection.createOffer();
        if (!isCurrent()) return;

        await peerConnection.setLocalDescription(offer);
        if (!isCurrent()) return;

        const sdp = peerConnection.localDescription?.sdp;
        if (!sdp) {
          throw createSessionStartError({
            kind: "connection-failed",
            message: "The browser could not create a voice connection offer.",
            retryable: true,
          });
        }

        const response = await fetch("/api/realtime/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sdp, voice }),
          signal: abortController.signal,
        });
        const responseBody = await readJson(response);
        if (!isCurrent()) return;

        if (!response.ok) {
          throw createSessionStartError(
            negotiationError(response.status, responseBody),
          );
        }

        if (!isSessionResponse(responseBody)) {
          throw createSessionStartError({
            kind: "service-error",
            message: "The voice service returned an invalid response.",
            retryable: true,
          });
        }

        await peerConnection.setRemoteDescription({
          type: "answer",
          sdp: responseBody.sdp,
        });
        if (!isCurrent()) return;

        addDiagnostic("session.negotiated");
        markConnectedIfReady();
      } catch (cause) {
        if (generationRef.current !== generation || !mountedRef.current) {
          return;
        }

        const knownError =
          typeof cause === "object" &&
          cause !== null &&
          "realtimeError" in cause
            ? (cause as SessionStartError).realtimeError
            : connectionError();
        failSession(generation, knownError);
      }
    },
    [
      addDiagnostic,
      cleanupResources,
      clearConnectionTimer,
      clearDisconnectedTimer,
      failSession,
      playRemoteAudio,
    ],
  );

  const stop = useCallback(() => {
    const hadSession =
      peerConnectionRef.current !== null ||
      microphoneStreamRef.current !== null ||
      abortControllerRef.current !== null;

    generationRef.current += 1;
    if (hadSession && mountedRef.current) {
      setConnectionState("disconnecting");
    }
    cleanupResources();

    if (!mountedRef.current) return;
    addDiagnostic("session.stopped");
    dispatchEvent({ type: "session-stopped" });
    setNeedsAudioResume(false);
    setIsMuted(false);
    setError(null);
    setConnectionState("idle");
  }, [addDiagnostic, cleanupResources]);

  const toggleMute = useCallback(() => {
    const stream = microphoneStreamRef.current;
    if (!stream) return;

    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) return;

    const nextMuted = tracks.some((track) => track.enabled);
    tracks.forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
    addDiagnostic(nextMuted ? "microphone.muted" : "microphone.unmuted");
  }, [addDiagnostic]);

  const resumeAudio = useCallback(async (): Promise<void> => {
    await playRemoteAudio(generationRef.current);
  }, [playRemoteAudio]);

  const restoreTranscript = useCallback(
    (turns: TranscriptTurn[]) => {
      const history = prepareConversationHistory(turns);
      dispatchEvent({ type: "restore-transcript", history });
      addDiagnostic("history.restored", `${history.transcript.length} turns`);
    },
    [addDiagnostic],
  );

  const clearTranscript = useCallback(() => {
    dispatchEvent({ type: "clear-transcript" });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      cleanupResources();
    };
  }, [cleanupResources]);

  return {
    connectionState,
    activityState: eventState.activityState,
    transcript: eventState.transcript,
    isMuted,
    needsAudioResume,
    error,
    diagnostics,
    start,
    stop,
    toggleMute,
    resumeAudio,
    restoreTranscript,
    clearTranscript,
  };
}

export default useRealtimeSession;
