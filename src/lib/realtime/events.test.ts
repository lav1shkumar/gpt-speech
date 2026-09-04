import { describe, expect, it } from "vitest";

import {
  createInitialRealtimeEventState,
  getRealtimeEventType,
  getRealtimeProtocolIssue,
  realtimeEventReducer,
  type RealtimeEventState,
} from "./events";

function serverEvent(
  state: RealtimeEventState,
  event: unknown,
): RealtimeEventState {
  return realtimeEventReducer(state, { type: "server-event", event });
}

describe("realtimeEventReducer", () => {
  it("tracks the server VAD and output audio activity lifecycle", () => {
    let state = createInitialRealtimeEventState();

    state = serverEvent(state, {
      type: "input_audio_buffer.speech_started",
    });
    expect(state.activityState).toBe("user-speaking");

    state = serverEvent(state, {
      type: "input_audio_buffer.speech_stopped",
    });
    expect(state.activityState).toBe("assistant-thinking");

    state = serverEvent(state, { type: "output_audio_buffer.started" });
    expect(state.activityState).toBe("assistant-speaking");

    state = serverEvent(state, { type: "output_audio_buffer.stopped" });
    expect(state.activityState).toBe("listening");
  });

  it("does not let delayed assistant events overwrite a barge-in", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "output_audio_buffer.started",
      event_id: "audio-started",
    });
    state = serverEvent(state, {
      type: "input_audio_buffer.speech_started",
      event_id: "speech-started",
    });

    state = serverEvent(state, {
      type: "output_audio_buffer.stopped",
      event_id: "delayed-audio-stopped",
    });
    state = serverEvent(state, {
      type: "response.done",
      event_id: "interrupted-response-done",
    });

    expect(state.activityState).toBe("user-speaking");
    expect(state.userSpeechActive).toBe(true);
  });

  it("preserves thinking when an interrupted output stop arrives after speech stops", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "input_audio_buffer.speech_started",
    });
    state = serverEvent(state, {
      type: "input_audio_buffer.speech_stopped",
    });
    state = serverEvent(state, { type: "output_audio_buffer.stopped" });

    expect(state.activityState).toBe("assistant-thinking");
  });

  it("clears assistant output state when barge-in removes buffered audio", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "output_audio_buffer.started",
    });
    state = serverEvent(state, {
      type: "input_audio_buffer.speech_started",
    });
    state = serverEvent(state, {
      type: "output_audio_buffer.cleared",
    });

    expect(state.activityState).toBe("user-speaking");
    expect(state.outputAudioActive).toBe(false);

    state = serverEvent(state, {
      type: "input_audio_buffer.speech_stopped",
    });

    expect(state.activityState).toBe("assistant-thinking");
  });

  it("adds completed input transcriptions and updates duplicate item IDs", () => {
    let state = createInitialRealtimeEventState();

    state = serverEvent(state, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "  Hello GPT  ",
    });
    state = serverEvent(state, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "Hello GPT!",
    });

    expect(state.transcript).toEqual([
      {
        id: "user:item-1",
        role: "user",
        text: "Hello GPT!",
        status: "complete",
      },
    ]);
  });

  it("orders a late user transcription before an already-streaming assistant turn", () => {
    let state = createInitialRealtimeEventState();
    state = serverEvent(state, {
      type: "conversation.item.created",
      event_id: "user-created",
      previous_item_id: null,
      item: { id: "user-1", type: "message", role: "user" },
    });
    state = serverEvent(state, {
      type: "conversation.item.added",
      event_id: "assistant-added",
      previous_item_id: "user-1",
      item: { id: "assistant-1", type: "message", role: "assistant" },
    });

    expect(state.transcript).toEqual([]);
    state = serverEvent(state, {
      type: "response.output_audio_transcript.delta",
      event_id: "assistant-delta",
      item_id: "assistant-1",
      delta: "The answer",
    });
    expect(state.transcript.map((turn) => turn.role)).toEqual(["assistant"]);

    state = serverEvent(state, {
      type: "conversation.item.input_audio_transcription.completed",
      event_id: "user-transcript",
      item_id: "user-1",
      transcript: "The question",
    });

    expect(state.transcript.map((turn) => turn.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(state.transcript.map((turn) => turn.text)).toEqual([
      "The question",
      "The answer",
    ]);
  });

  it("uses previous-item links when item metadata itself arrives out of order", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "conversation.item.added",
      previous_item_id: "user-1",
      item: { id: "assistant-1" },
    });
    state = serverEvent(state, {
      type: "response.output_audio_transcript.done",
      item_id: "assistant-1",
      transcript: "Later",
    });
    state = serverEvent(state, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "user-1",
      transcript: "Earlier",
    });
    expect(state.transcript.map((turn) => turn.role)).toEqual([
      "assistant",
      "user",
    ]);

    state = serverEvent(state, {
      type: "conversation.item.created",
      previous_item_id: null,
      item: { id: "user-1" },
    });

    expect(state.transcript.map((turn) => turn.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("merges assistant deltas and replaces them with the authoritative done text", () => {
    let state = createInitialRealtimeEventState();

    state = serverEvent(state, {
      type: "response.output_audio_transcript.delta",
      item_id: "item-2",
      delta: "Good ",
    });
    state = serverEvent(state, {
      type: "response.output_audio_transcript.delta",
      item_id: "item-2",
      delta: "morning",
    });

    expect(state.transcript[0]).toEqual({
      id: "assistant:item-2",
      role: "assistant",
      text: "Good morning",
      status: "streaming",
    });

    state = serverEvent(state, {
      type: "response.output_audio_transcript.done",
      item_id: "item-2",
      transcript: "Good morning!",
    });

    expect(state.transcript[0]).toEqual({
      id: "assistant:item-2",
      role: "assistant",
      text: "Good morning!",
      status: "complete",
    });
  });

  it("preserves a partial assistant transcript when the done text is empty", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "response.output_audio_transcript.delta",
      item_id: "item-2",
      delta: "Partial but still useful",
    });

    state = serverEvent(state, {
      type: "response.output_audio_transcript.done",
      item_id: "item-2",
      transcript: "   ",
    });

    expect(state.transcript[0]).toEqual({
      id: "assistant:item-2",
      role: "assistant",
      text: "Partial but still useful",
      status: "complete",
    });
  });

  it("deduplicates replayed transcript delta events by event ID", () => {
    const delta = {
      type: "response.output_audio_transcript.delta",
      event_id: "event-1",
      item_id: "item-2",
      delta: "Only once",
    };
    let state = serverEvent(createInitialRealtimeEventState(), delta);
    const afterFirstDelivery = state;
    state = serverEvent(state, delta);

    expect(state).toBe(afterFirstDelivery);
    expect(state.transcript[0]?.text).toBe("Only once");
  });

  it("can create a complete assistant turn when no deltas were delivered", () => {
    const state = serverEvent(createInitialRealtimeEventState(), {
      type: "response.output_audio_transcript.done",
      response_id: "response-1",
      transcript: "A complete answer",
    });

    expect(state.transcript).toEqual([
      {
        id: "assistant:response-1",
        role: "assistant",
        text: "A complete answer",
        status: "complete",
      },
    ]);
  });

  it("ignores late deltas after a transcript has completed", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "response.output_audio_transcript.done",
      item_id: "item-2",
      transcript: "Final",
    });

    state = serverEvent(state, {
      type: "response.output_audio_transcript.delta",
      item_id: "item-2",
      delta: " duplicate",
    });

    expect(state.transcript[0]?.text).toBe("Final");
  });

  it("finalizes the matching streaming turn when the response ends", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "response.output_audio_transcript.delta",
      item_id: "item-2",
      delta: "Partial but usable",
    });
    state = serverEvent(state, {
      type: "response.done",
      response: { id: "response-2", output: [{ id: "item-2" }] },
    });

    expect(state.activityState).toBe("listening");
    expect(state.transcript[0]?.status).toBe("complete");
  });

  it("does not finalize a newer turn when an older response ends late", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "response.output_audio_transcript.delta",
      item_id: "item-old",
      delta: "Older response",
    });
    state = serverEvent(state, {
      type: "response.output_audio_transcript.delta",
      item_id: "item-new",
      delta: "New response still streaming",
    });

    state = serverEvent(state, {
      type: "response.done",
      response: { id: "response-old", output: [{ id: "item-old" }] },
    });

    expect(state.transcript).toEqual([
      expect.objectContaining({ id: "assistant:item-old", status: "complete" }),
      expect.objectContaining({ id: "assistant:item-new", status: "streaming" }),
    ]);
  });

  it("keeps assistant-speaking active until output audio actually stops", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "output_audio_buffer.started",
    });

    state = serverEvent(state, { type: "response.done" });
    expect(state.activityState).toBe("assistant-speaking");
    expect(state.outputAudioActive).toBe(true);

    state = serverEvent(state, { type: "output_audio_buffer.stopped" });
    expect(state.activityState).toBe("listening");
    expect(state.outputAudioActive).toBe(false);
  });

  it("keeps assistant-speaking active through a recoverable service error", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "output_audio_buffer.started",
    });

    state = serverEvent(state, {
      type: "error",
      error: { message: "Recoverable event error" },
    });

    expect(state.activityState).toBe("assistant-speaking");
    expect(state.outputAudioActive).toBe(true);
    expect(state.protocolIssue).toBe("service-error");
  });

  it("marks an unfinished assistant turn interrupted on stop", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "response.output_audio_transcript.delta",
      item_id: "item-2",
      delta: "Keep me",
    });
    state = serverEvent(state, { type: "error", error: { message: "secret" } });

    state = realtimeEventReducer(state, { type: "session-stopped" });

    expect(state.activityState).toBe("listening");
    expect(state.protocolIssue).toBeNull();
    expect(state.transcript[0]).toMatchObject({
      text: "Keep me",
      status: "interrupted",
    });
  });

  it("supports explicit transcript clearing without changing activity", () => {
    const populated = serverEvent(createInitialRealtimeEventState(), {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "Hello",
    });
    const speaking = serverEvent(populated, {
      type: "output_audio_buffer.started",
    });

    const cleared = realtimeEventReducer(speaking, {
      type: "clear-transcript",
    });

    expect(cleared.transcript).toEqual([]);
    expect(cleared.activityState).toBe("assistant-speaking");
  });

  it("resets transcript and transient protocol state for a new session", () => {
    let state = serverEvent(createInitialRealtimeEventState(), {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "Old conversation",
    });
    state = serverEvent(state, { type: "error" });

    expect(
      realtimeEventReducer(state, { type: "reset-session" }),
    ).toEqual(createInitialRealtimeEventState());
  });

  it("ignores malformed, empty, and unknown events without changing identity", () => {
    const state = createInitialRealtimeEventState();

    expect(serverEvent(state, null)).toBe(state);
    expect(serverEvent(state, { type: 42 })).toBe(state);
    expect(serverEvent(state, { type: "unknown.event", api_key: "nope" })).toBe(
      state,
    );
    expect(
      serverEvent(state, {
        type: "response.output_audio_transcript.delta",
        event_id: "unique-event-id-is-not-a-turn-id",
        delta: "orphaned delta",
      }),
    ).toEqual(state);
    expect(
      serverEvent(state, {
        type: "response.output_audio_transcript.delta",
        item_id: "item-1",
        delta: "",
      }),
    ).toEqual(state);
  });
});

describe("realtime event inspection", () => {
  it("extracts only string event types", () => {
    expect(getRealtimeEventType({ type: "response.done" })).toBe(
      "response.done",
    );
    expect(getRealtimeEventType({ type: 1 })).toBeNull();
    expect(getRealtimeEventType("response.done")).toBeNull();
  });

  it("maps service and transcription failures without retaining server details", () => {
    expect(
      getRealtimeProtocolIssue({
        type: "error",
        error: { message: "sensitive upstream detail", code: "anything" },
      }),
    ).toBe("service-error");
    expect(
      getRealtimeProtocolIssue({
        type: "conversation.item.input_audio_transcription.failed",
        error: { message: "sensitive upstream detail" },
      }),
    ).toBe("transcription-failed");
  });
});
