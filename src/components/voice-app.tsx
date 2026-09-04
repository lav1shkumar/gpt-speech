"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AudioLines,
  ChevronDown,
  CircleAlert,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  Play,
  RefreshCw,
  ShieldCheck,
  Volume2,
} from "lucide-react";

import { Transcript } from "@/components/transcript";
import { VoiceOrb } from "@/components/voice-orb";
import { useRealtimeSession } from "@/hooks/use-realtime-session";
import {
  clearConversation,
  loadConversation,
  saveConversation,
} from "@/lib/browser/conversation-store";
import {
  VOICES,
  type ActivityState,
  type ConnectionState,
  type TranscriptTurn,
  type VoiceId,
} from "@/lib/realtime/types";
import { prepareConversationHistory } from "@/lib/realtime/history";

const CONNECTION_COPY: Record<ConnectionState, { title: string; detail: string }> = {
  idle: { title: "Ready when you are", detail: "Choose a voice, then start a conversation." },
  "requesting-microphone": { title: "Allow microphone access", detail: "Your browser will ask for permission." },
  negotiating: { title: "Connecting", detail: "Opening a secure realtime session…" },
  connected: { title: "Connected", detail: "You can speak naturally." },
  disconnecting: { title: "Ending conversation", detail: "Closing your session safely…" },
  error: { title: "Couldn’t connect", detail: "Review the message below and try again." },
};

const ACTIVITY_COPY: Record<ActivityState, { title: string; detail: string }> = {
  listening: { title: "Listening", detail: "Go ahead — I’m ready." },
  "user-speaking": { title: "Listening to you", detail: "Keep going, I won’t interrupt." },
  "assistant-thinking": { title: "Thinking", detail: "Putting together a response…" },
  "assistant-speaking": { title: "Speaking", detail: "You can interrupt at any time." },
};

const ERROR_GUIDANCE: Record<string, string> = {
  "unsupported-browser": "Open this page in a current version of Chrome, Edge, or Safari.",
  "insecure-context": "Microphone access requires a secure HTTPS connection.",
  "microphone-denied": "Allow microphone access in your browser’s site settings, then try again.",
  "microphone-missing": "Connect a microphone and make sure it is available to your browser.",
  "microphone-unavailable": "Close other apps using your microphone, then try again.",
  "autoplay-blocked": "Your browser needs one more click before it can play GPT’s voice.",
  offline: "Check your internet connection, then try again.",
  "connection-failed": "The realtime connection was interrupted. Try starting a new conversation.",
  "service-error": "The voice service is temporarily unavailable. Please try again shortly.",
};

const ACTIVE_STATES: ConnectionState[] = [
  "requesting-microphone",
  "negotiating",
  "connected",
  "disconnecting",
];

const DEFAULT_VOICE: VoiceId = "coral";
type ResetState = "idle" | "pending" | "success" | "error";

function conversationSignature(voice: VoiceId, transcript: TranscriptTurn[]): string {
  return JSON.stringify({ voice, transcript });
}

export function VoiceApp() {
  const {
    connectionState,
    activityState,
    transcript,
    isMuted,
    needsAudioResume,
    error,
    diagnostics,
    start,
    stop,
    toggleMute,
    resumeAudio,
    clearTranscript,
    restoreTranscript,
  } = useRealtimeSession();
  const [voice, setVoice] = useState<VoiceId>(DEFAULT_VOICE);
  const [storageReady, setStorageReady] = useState(false);
  const [resetState, setResetState] = useState<ResetState>("idle");
  const [restoredTurnIds, setRestoredTurnIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const lastSavedSignatureRef = useRef<string | null>(null);
  const storageQueueRef = useRef<Promise<void>>(Promise.resolve());

  const isActive = ACTIVE_STATES.includes(connectionState);
  const canEnd = isActive && connectionState !== "disconnecting";
  const canMute = connectionState === "connected";
  const hasHistory = transcript.length > 0;
  const status = useMemo(() => {
    if (!storageReady) {
      return {
        title: "Loading conversation",
        detail: "Checking this browser for saved history…",
      };
    }

    if (connectionState === "idle" && hasHistory) {
      return {
        title: "Ready to continue",
        detail: "Your saved transcript will be used as context in the next session.",
      };
    }

    return connectionState === "connected"
      ? ACTIVITY_COPY[activityState]
      : CONNECTION_COPY[connectionState];
  }, [activityState, connectionState, hasHistory, storageReady]);
  const selectedVoice = VOICES.find((option) => option.id === voice) ?? VOICES[3];

  const queueStorageOperation = useCallback(<Result,>(operation: () => Promise<Result>) => {
    const queued = storageQueueRef.current.then(operation, operation);
    storageQueueRef.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }, []);

  useEffect(() => {
    let cancelled = false;

    void loadConversation().then((savedConversation) => {
      if (cancelled) return;

      if (savedConversation) {
        const restoredTurns = prepareConversationHistory(
          savedConversation.turns,
        ).transcript;
        lastSavedSignatureRef.current = conversationSignature(
          savedConversation.voice,
          restoredTurns,
        );
        setVoice(savedConversation.voice);
        setRestoredTurnIds(new Set(restoredTurns.map((turn) => turn.id)));
        restoreTranscript(restoredTurns);
      } else {
        lastSavedSignatureRef.current = conversationSignature(DEFAULT_VOICE, []);
      }

      setStorageReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [restoreTranscript]);

  useEffect(() => {
    if (!storageReady) return;

    const completedTurns = transcript.filter(
      (turn) => turn.status === "complete" && turn.text.trim().length > 0,
    );
    if (completedTurns.length === 0) return;

    const signature = conversationSignature(voice, completedTurns);
    if (signature === lastSavedSignatureRef.current) return;

    lastSavedSignatureRef.current = signature;
    void queueStorageOperation(() => saveConversation({ voice, turns: completedTurns }));
  }, [queueStorageOperation, storageReady, transcript, voice]);

  const handleStart = () => {
    setResetState("idle");
    void start(voice, transcript);
    statusRef.current?.focus();
  };

  const handleStop = () => {
    stop();
    statusRef.current?.focus();
  };

  const handleResumeAudio = async () => {
    await resumeAudio();
    statusRef.current?.focus();
  };

  const handleReset = async () => {
    const hasConversation = hasHistory || isActive;
    if (!hasConversation || resetState === "pending") return;

    if (
      !window.confirm(
        "Reset this conversation? This ends the current session and permanently clears its transcript from this browser.",
      )
    ) {
      return;
    }

    if (isActive) stop();
    setResetState("pending");

    const cleared = await queueStorageOperation(clearConversation);
    if (!cleared) {
      setResetState("error");
      return;
    }

    lastSavedSignatureRef.current = conversationSignature(voice, []);
    setRestoredTurnIds(new Set());
    clearTranscript();
    setResetState("success");
  };

  return (
    <main className="app-shell">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="GPT Voice home">
          <span className="brand__mark"><AudioLines size={19} strokeWidth={2.2} /></span>
          <span>GPT Voice</span>
        </Link>
        <span className="privacy-badge"><ShieldCheck size={15} /> Browser-local text</span>
      </header>

      <div className="app-grid" id="main-content" aria-busy={!storageReady || resetState === "pending"}>
        <section className="call-card" aria-labelledby="call-title">
          <div className="call-card__topline">
            <div>
              <p className="eyebrow">Realtime conversation</p>
              <h1 id="call-title">Talk with GPT</h1>
            </div>
            <span className="connection-pill" data-connected={connectionState === "connected"}>
              <i aria-hidden="true" />
              {connectionState === "connected" ? "Live" : isActive ? "Connecting" : "Offline"}
            </span>
          </div>

          <div className="call-stage">
            <VoiceOrb connectionState={connectionState} activityState={activityState} />
            <div
              className="status-copy"
              ref={statusRef}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              tabIndex={-1}
            >
              <h2>{status.title}</h2>
              <p>{status.detail}</p>
            </div>
          </div>

          {needsAudioResume ? (
            <div className="inline-notice inline-notice--sound" role="alert">
              <span className="inline-notice__icon"><Headphones size={20} /></span>
              <div><strong>GPT is responding</strong><p>Enable sound to hear the conversation.</p></div>
              <button className="notice-action" type="button" onClick={() => void handleResumeAudio()}>
                <Volume2 size={17} /> Enable sound
              </button>
            </div>
          ) : null}

          {error && error.kind !== "autoplay-blocked" ? (
            <div className="inline-notice inline-notice--error" role="alert">
              <span className="inline-notice__icon"><CircleAlert size={20} /></span>
              <div>
                <strong>{error.message}</strong>
                <p>{ERROR_GUIDANCE[error.kind] ?? "Try starting a new conversation."}</p>
              </div>
              {error.retryable ? (
                <button className="notice-action" type="button" onClick={handleStart}>
                  <RefreshCw size={16} /> Try again
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="call-controls">
            <div className="voice-field">
              <label htmlFor="voice-select">Voice</label>
              <span className="select-wrap">
                <select
                  id="voice-select"
                  value={voice}
                  onChange={(event) => setVoice(event.target.value as VoiceId)}
                  disabled={isActive || !storageReady || resetState === "pending"}
                  aria-describedby="voice-description"
                >
                  {VOICES.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                </select>
                <ChevronDown size={17} aria-hidden="true" />
              </span>
              <small id="voice-description">{selectedVoice.description}</small>
            </div>

            <div className="control-actions">
              {connectionState === "idle" ? (
                <button className="button button--start" type="button" onClick={handleStart} disabled={!storageReady || resetState === "pending"}>
                  <Play size={19} fill="currentColor" /> {hasHistory ? "Continue conversation" : "Start conversation"}
                </button>
              ) : isActive ? (
                <>
                  <button
                    className="button button--round"
                    type="button"
                    onClick={toggleMute}
                    disabled={!canMute}
                    aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
                    aria-pressed={isMuted}
                    data-muted={isMuted}
                  >
                    {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
                    <span>{isMuted ? "Unmute" : "Mute"}</span>
                  </button>
                  <button
                    className="button button--end"
                    type="button"
                    onClick={handleStop}
                    disabled={!canEnd}
                    aria-label="End conversation"
                  >
                    <PhoneOff size={20} /> End
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <p className="privacy-note"><ShieldCheck size={14} /> Transcript text stays in this browser. When you continue, recent text is sent to Azure as context. Audio is streamed live and never stored by this app.</p>

          {process.env.NODE_ENV === "development" ? (
            <div className="diagnostics">
              <button type="button" onClick={() => setShowDiagnostics((current) => !current)} aria-expanded={showDiagnostics}>
                Diagnostics <ChevronDown size={14} />
              </button>
              {showDiagnostics ? (
                <ol>
                  {diagnostics.length === 0 ? <li>No protocol events yet.</li> : diagnostics.map((entry) => (
                    <li key={entry.id}><time>{entry.at}</time><strong>{entry.type}</strong>{entry.detail ? <span>{entry.detail}</span> : null}</li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : null}
        </section>

        <Transcript
          turns={transcript}
          onReset={() => void handleReset()}
          resetDisabled={!storageReady || resetState === "pending" || (!hasHistory && !isActive)}
          resetState={resetState}
          silentTurnIds={restoredTurnIds}
        />
      </div>

      <footer className="site-footer">
        <span>Powered by Azure OpenAI Realtime</span>
        <span aria-hidden="true">•</span>
        <span>Use headphones for the clearest conversation</span>
        <span aria-hidden="true">•</span>
        <span className="site-footer__credit">Made by <strong>Lavish</strong></span>
      </footer>
    </main>
  );
}
