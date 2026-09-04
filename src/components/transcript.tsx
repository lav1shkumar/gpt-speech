"use client";

import { useEffect, useRef } from "react";
import { AudioLines, RotateCcw } from "lucide-react";

import type { TranscriptTurn } from "@/lib/realtime/types";

type TranscriptProps = {
  turns: TranscriptTurn[];
  onReset?: () => void;
  resetDisabled?: boolean;
  resetState?: "idle" | "pending" | "success" | "error";
  silentTurnIds?: ReadonlySet<string>;
};

export function Transcript({
  turns,
  onReset,
  resetDisabled = false,
  resetState = "idle",
  silentTurnIds,
}: TranscriptProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    if (turns.length === 0) {
      shouldAutoScrollRef.current = true;
      list.scrollTop = 0;
    } else if (shouldAutoScrollRef.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [turns]);

  const updateAutoScrollPreference = () => {
    const list = listRef.current;
    if (!list) return;

    const distanceFromBottom =
      list.scrollHeight - list.clientHeight - list.scrollTop;
    shouldAutoScrollRef.current = distanceFromBottom <= 80;
  };

  return (
    <section className="transcript-card" aria-labelledby="transcript-heading">
      <header className="transcript-card__header">
        <div>
          <p className="eyebrow">Conversation</p>
          <h2 id="transcript-heading">Transcript</h2>
        </div>
        <div className="transcript-card__actions">
          {turns.length > 0 ? <span className="turn-count">{turns.length} {turns.length === 1 ? "turn" : "turns"}</span> : null}
          <button
            className="transcript-reset"
            type="button"
            onClick={onReset}
            disabled={resetDisabled}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {resetState === "pending" ? "Resetting…" : "Reset session"}
          </button>
        </div>
      </header>

      {resetState === "success" ? (
        <p className="transcript-reset-status" role="status">
          Conversation reset. The local transcript was cleared.
        </p>
      ) : resetState === "error" ? (
        <p className="transcript-reset-status transcript-reset-status--error" role="alert">
          The browser could not clear this transcript. Please try Reset session again.
        </p>
      ) : null}

      <div
        className="transcript-list"
        ref={listRef}
        role="region"
        aria-label="Conversation transcript"
        aria-live="off"
        tabIndex={0}
        onScroll={updateAutoScrollPreference}
      >
        {turns.length === 0 ? (
          <div className="transcript-empty">
            <span className="transcript-empty__icon"><AudioLines size={22} strokeWidth={1.7} /></span>
            <p>Your conversation will appear here.</p>
            <span>Start talking naturally — you can interrupt GPT at any time.</span>
          </div>
        ) : (
          turns.map((turn) => (
            <article className="transcript-turn" data-role={turn.role} key={turn.id}>
              <div className="transcript-turn__meta">
                <span>{turn.role === "user" ? "You" : "GPT"}</span>
                {turn.status === "streaming" ? (
                  <span className="streaming-label" aria-label="Transcription in progress">
                    <i aria-hidden="true" /> Live
                  </span>
                ) : turn.status === "interrupted" ? (
                  <span className="streaming-label" aria-label="Response interrupted">
                    Interrupted
                  </span>
                ) : null}
              </div>
              <p>{turn.text || <span className="thinking-dots" aria-label="Thinking"><i /><i /><i /></span>}</p>
            </article>
          ))
        )}
      </div>

      <div className="sr-only" aria-live="polite" aria-relevant="additions text">
        {turns
          .filter(
            (turn) =>
              turn.status === "complete" && !silentTurnIds?.has(turn.id),
          )
          .map((turn) => (
            <span key={turn.id}>
              {turn.role === "user" ? "You" : "GPT"}: {turn.text}
            </span>
          ))}
      </div>
    </section>
  );
}
