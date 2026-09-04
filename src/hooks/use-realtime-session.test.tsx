import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONNECTION_ESTABLISHMENT_TIMEOUT_MS,
  DISCONNECTED_GRACE_MS,
  useRealtimeSession,
} from "./use-realtime-session";

type MockTrack = {
  enabled: boolean;
  onended: (() => void) | null;
  stop: ReturnType<typeof vi.fn>;
};

type MockStream = {
  getTracks: () => MockTrack[];
  getAudioTracks: () => MockTrack[];
};

class MockDataChannel {
  readyState = "open";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
  });
}

class MockPeerConnection {
  static instances: MockPeerConnection[] = [];

  connectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { streams: MockStream[]; track: MockTrack }) => void) | null =
    null;
  readonly channel = new MockDataChannel();
  addTrack = vi.fn();
  close = vi.fn(() => {
    this.connectionState = "closed";
  });
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "browser-offer" }));
  setLocalDescription = vi.fn(async (description: { type: string; sdp: string }) => {
    this.localDescription = description;
  });
  setRemoteDescription = vi.fn(async () => undefined);

  constructor() {
    MockPeerConnection.instances.push(this);
  }

  emitConnectionState(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

function createMicrophone() {
  const track: MockTrack = { enabled: true, onended: null, stop: vi.fn() };
  const stream: MockStream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
  return { track, stream };
}

const fetchMock = vi.fn();
const getUserMediaMock = vi.fn();
const playMock = vi.fn();
const pauseMock = vi.fn();

class MockAudio {
  autoplay = false;
  srcObject: unknown = null;
  play = playMock;
  pause = pauseMock;
  setAttribute = vi.fn();
}

function installBrowserMocks() {
  vi.stubGlobal("RTCPeerConnection", MockPeerConnection);
  vi.stubGlobal("Audio", MockAudio);
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: getUserMediaMock },
  });
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
}

describe("useRealtimeSession", () => {
  beforeEach(() => {
    MockPeerConnection.instances = [];
    fetchMock.mockReset();
    getUserMediaMock.mockReset();
    playMock.mockReset().mockResolvedValue(undefined);
    pauseMock.mockReset();
    installBrowserMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sdp: "azure-answer" }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("negotiates through the server route and drives call controls", async () => {
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result, unmount } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("coral");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/realtime/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sdp: "browser-offer", voice: "coral" }),
      }),
    );
    expect(result.current.connectionState).toBe("negotiating");

    const peer = MockPeerConnection.instances[0];
    act(() => peer.emitConnectionState("connected"));
    expect(result.current.connectionState).toBe("connected");

    act(() => {
      peer.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "user-1",
          transcript: "Hello",
        }),
      });
      peer.channel.onmessage?.({
        data: JSON.stringify({
          type: "response.output_audio_transcript.delta",
          item_id: "assistant-1",
          delta: "Hi there",
        }),
      });
    });
    expect(result.current.transcript.map((turn) => turn.text)).toEqual([
      "Hello",
      "Hi there",
    ]);

    act(() => result.current.toggleMute());
    expect(result.current.isMuted).toBe(true);
    expect(track.enabled).toBe(false);

    act(() => result.current.stop());
    expect(result.current.connectionState).toBe("idle");
    expect(result.current.transcript).toHaveLength(2);
    expect(result.current.transcript[1]?.status).toBe("interrupted");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();

    unmount();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("connects without sending replay events when no history is supplied", async () => {
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("coral");
    });
    const peer = MockPeerConnection.instances[0];
    act(() => peer.emitConnectionState("connected"));

    expect(peer.channel.send).not.toHaveBeenCalled();
    expect(result.current.connectionState).toBe("connected");
    expect(track.enabled).toBe(true);
    expect(result.current.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "history.replay-skipped",
          detail: "no-history",
        }),
      ]),
    );
  });

  it("replays completed history in order before exposing a connected session", async () => {
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const priorTurns = [
      {
        id: "user:item_old_user",
        role: "user" as const,
        text: "Remember Paris",
        status: "complete" as const,
      },
      {
        id: "assistant:item_old_assistant",
        role: "assistant" as const,
        text: "I will remember Paris",
        status: "complete" as const,
      },
      {
        id: "assistant:item_partial",
        role: "assistant" as const,
        text: "unfinished",
        status: "streaming" as const,
      },
    ];
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("coral", priorTurns);
    });
    const peer = MockPeerConnection.instances[0];
    expect(peer.channel.send).not.toHaveBeenCalled();
    expect(result.current.connectionState).toBe("negotiating");
    expect(track.enabled).toBe(false);
    const statesAtSend: string[] = [];
    peer.channel.send.mockImplementation(() => {
      statesAtSend.push(result.current.connectionState);
    });

    act(() => peer.emitConnectionState("connected"));

    const sentEvents = peer.channel.send.mock.calls.map(([payload]) =>
      JSON.parse(payload as string),
    );
    expect(sentEvents).toEqual([
      {
        event_id: expect.stringMatching(/^history_replay_0_[a-z0-9]+$/),
        type: "conversation.item.create",
        item: {
          id: "item_old_user",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Remember Paris" }],
        },
      },
      {
        event_id: expect.stringMatching(/^history_replay_1_[a-z0-9]+$/),
        type: "conversation.item.create",
        previous_item_id: "item_old_user",
        item: {
          id: "item_old_assistant",
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "I will remember Paris" },
          ],
        },
      },
    ]);
    expect(sentEvents.some((event) => event.type === "response.create")).toBe(
      false,
    );
    expect(statesAtSend).toEqual(["negotiating", "negotiating"]);
    expect(result.current.connectionState).toBe("negotiating");
    expect(track.enabled).toBe(false);

    act(() => {
      peer.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.added",
          item: { id: "item_old_user" },
        }),
      });
    });
    expect(result.current.connectionState).toBe("negotiating");
    expect(track.enabled).toBe(false);

    act(() => {
      peer.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.created",
          previous_item_id: "item_old_user",
          item: { id: "item_old_assistant" },
        }),
      });
    });
    expect(result.current.connectionState).toBe("connected");
    expect(track.enabled).toBe(true);
    expect(result.current.transcript.map((turn) => turn.text)).toEqual([
      "Remember Paris",
      "I will remember Paris",
    ]);
    expect(result.current.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "history.replayed" }),
        expect.objectContaining({ type: "history.replay-acknowledged" }),
        expect.objectContaining({ type: "microphone.replay-gate-opened" }),
      ]),
    );

    act(() => peer.channel.onopen?.());
    expect(peer.channel.send).toHaveBeenCalledTimes(2);
  });

  it("restores validated history and keeps its order ahead of new live turns", async () => {
    const { stream } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderHook(() => useRealtimeSession());
    const restoreTranscript = result.current.restoreTranscript;

    act(() => {
      result.current.restoreTranscript([
        {
          id: "user:item_old_user",
          role: "user",
          text: "Old question",
          status: "complete",
        },
        {
          id: "assistant:item_old_assistant",
          role: "assistant",
          text: "Old answer",
          status: "complete",
        },
        {
          id: "user:item_incomplete",
          role: "user",
          text: "Ignore this",
          status: "streaming",
        },
      ]);
    });

    expect(result.current.restoreTranscript).toBe(restoreTranscript);
    expect(result.current.transcript.map((turn) => turn.text)).toEqual([
      "Old question",
      "Old answer",
    ]);

    const restored = result.current.transcript;
    await act(async () => {
      await result.current.start("coral", restored);
    });
    const peer = MockPeerConnection.instances[0];
    act(() => {
      peer.emitConnectionState("connected");
      peer.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.created",
          previous_item_id: "item_old_user",
          item: { id: "item_old_assistant" },
        }),
      });
      peer.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.added",
          previous_item_id: "item_old_assistant",
          item: { id: "item_new_user" },
        }),
      });
      peer.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.added",
          previous_item_id: "item_new_user",
          item: { id: "item_new_assistant" },
        }),
      });
      peer.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item_new_user",
          transcript: "New question",
        }),
      });
      peer.channel.onmessage?.({
        data: JSON.stringify({
          type: "response.output_audio_transcript.done",
          item_id: "item_new_assistant",
          transcript: "New answer",
        }),
      });
    });

    expect(result.current.transcript.map((turn) => turn.text)).toEqual([
      "Old question",
      "Old answer",
      "New question",
      "New answer",
    ]);
  });

  it("fails safely when Azure rejects a replay event", async () => {
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("coral", [
        {
          id: "user:item_old_user",
          role: "user",
          text: "Restore me",
          status: "complete",
        },
      ]);
    });
    const peer = MockPeerConnection.instances[0];
    act(() => peer.emitConnectionState("connected"));
    const replayEvent = JSON.parse(
      peer.channel.send.mock.calls[0]?.[0] as string,
    ) as { event_id: string };

    act(() => {
      peer.channel.onmessage?.({
        data: JSON.stringify({
          type: "error",
          event_id: "server-error-event",
          error: {
            event_id: replayEvent.event_id,
            type: "invalid_request_error",
            message: "sensitive upstream detail",
          },
        }),
      });
    });

    expect(result.current.connectionState).toBe("error");
    expect(result.current.error).toEqual(
      expect.objectContaining({
        kind: "connection-failed",
        message: expect.not.stringContaining("sensitive upstream detail"),
        retryable: true,
      }),
    );
    expect(track.enabled).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(result.current.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "history.replay-rejected",
          detail: replayEvent.event_id,
        }),
      ]),
    );
  });

  it("keeps the establishment deadline active while awaiting replay acknowledgement", async () => {
    vi.useFakeTimers();
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("coral", [
        {
          id: "assistant:item_old_assistant",
          role: "assistant",
          text: "Prior context",
          status: "complete",
        },
      ]);
    });
    const peer = MockPeerConnection.instances[0];
    act(() => {
      peer.emitConnectionState("connected");
      vi.advanceTimersByTime(CONNECTION_ESTABLISHMENT_TIMEOUT_MS);
    });

    expect(peer.channel.send).toHaveBeenCalledOnce();
    expect(result.current.connectionState).toBe("error");
    expect(result.current.error?.message).toContain("timed out");
    expect(track.enabled).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(result.current.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "history.replay-timeout" }),
      ]),
    );
  });

  it("maps microphone permission denial to an actionable error", async () => {
    getUserMediaMock.mockRejectedValue(
      Object.assign(new Error("browser-specific details"), {
        name: "NotAllowedError",
      }),
    );
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("alloy");
    });

    expect(result.current.connectionState).toBe("error");
    expect(result.current.error).toEqual(
      expect.objectContaining({ kind: "microphone-denied", retryable: true }),
    );
    expect(result.current.error?.message).not.toContain("browser-specific");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a stale start and stops a late microphone stream", async () => {
    let resolveMicrophone!: (stream: MockStream) => void;
    getUserMediaMock.mockReturnValue(
      new Promise<MockStream>((resolve) => {
        resolveMicrophone = resolve;
      }),
    );
    const { stream, track } = createMicrophone();
    const { result } = renderHook(() => useRealtimeSession());

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start("sage");
    });
    act(() => result.current.stop());
    resolveMicrophone(stream);
    await act(async () => {
      await startPromise;
    });

    expect(result.current.connectionState).toBe("idle");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockPeerConnection.instances).toHaveLength(0);
  });

  it("allows a five-second disconnected grace period without reconnecting", async () => {
    vi.useFakeTimers();
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("echo");
    });
    const peer = MockPeerConnection.instances[0];
    act(() => {
      peer.emitConnectionState("connected");
      peer.emitConnectionState("disconnected");
      vi.advanceTimersByTime(DISCONNECTED_GRACE_MS - 1);
    });
    expect(result.current.connectionState).toBe("connected");
    expect(fetchMock).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.connectionState).toBe("error");
    expect(result.current.error?.kind).toBe("connection-failed");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("cancels the disconnect timer when the peer recovers", async () => {
    vi.useFakeTimers();
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("verse");
    });
    const peer = MockPeerConnection.instances[0];
    act(() => {
      peer.emitConnectionState("connected");
      peer.emitConnectionState("disconnected");
      vi.advanceTimersByTime(DISCONNECTED_GRACE_MS - 1);
      peer.emitConnectionState("connected");
      vi.advanceTimersByTime(1);
    });

    expect(result.current.connectionState).toBe("connected");
    expect(result.current.error).toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("fails and cleans up when connection establishment times out", async () => {
    vi.useFakeTimers();
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("coral");
    });
    const peer = MockPeerConnection.instances[0];
    expect(result.current.connectionState).toBe("negotiating");

    act(() => vi.advanceTimersByTime(CONNECTION_ESTABLISHMENT_TIMEOUT_MS));

    expect(result.current.connectionState).toBe("error");
    expect(result.current.error).toEqual(
      expect.objectContaining({
        kind: "connection-failed",
        message: expect.stringContaining("timed out"),
        retryable: true,
      }),
    );
    expect(track.stop).toHaveBeenCalledOnce();
    expect(track.onended).toBeNull();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the establishment deadline until the data channel opens", async () => {
    vi.useFakeTimers();
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("coral");
    });
    const peer = MockPeerConnection.instances[0];
    peer.channel.readyState = "connecting";

    act(() => {
      peer.emitConnectionState("connected");
      vi.advanceTimersByTime(CONNECTION_ESTABLISHMENT_TIMEOUT_MS);
    });

    expect(result.current.connectionState).toBe("error");
    expect(result.current.error?.message).toContain("timed out");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it("connects once both the peer and data channel are ready", async () => {
    vi.useFakeTimers();
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("coral");
    });
    const peer = MockPeerConnection.instances[0];
    peer.channel.readyState = "connecting";

    act(() => peer.emitConnectionState("connected"));
    expect(result.current.connectionState).toBe("negotiating");

    act(() => {
      peer.channel.readyState = "open";
      peer.channel.onopen?.();
      vi.advanceTimersByTime(CONNECTION_ESTABLISHMENT_TIMEOUT_MS);
    });

    expect(result.current.connectionState).toBe("connected");
    expect(result.current.error).toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("cancels the establishment timeout after connecting", async () => {
    vi.useFakeTimers();
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("coral");
    });
    const peer = MockPeerConnection.instances[0];
    act(() => {
      peer.emitConnectionState("connected");
      vi.advanceTimersByTime(CONNECTION_ESTABLISHMENT_TIMEOUT_MS);
    });

    expect(result.current.connectionState).toBe("connected");
    expect(result.current.error).toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("fails safely when the local microphone track ends", async () => {
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("coral");
    });
    const peer = MockPeerConnection.instances[0];
    act(() => peer.emitConnectionState("connected"));
    const endedHandler = track.onended;
    expect(endedHandler).toBeTypeOf("function");

    act(() => endedHandler?.());

    expect(result.current.connectionState).toBe("error");
    expect(result.current.error).toEqual(
      expect.objectContaining({
        kind: "microphone-unavailable",
        retryable: true,
      }),
    );
    expect(track.onended).toBeNull();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it("surfaces autoplay blocking and recovers after an explicit resume", async () => {
    const { stream, track } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    playMock.mockRejectedValueOnce(new Error("NotAllowedError"));
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("shimmer");
    });
    const peer = MockPeerConnection.instances[0];

    await act(async () => {
      peer.ontrack?.({ streams: [stream], track });
      await Promise.resolve();
    });
    expect(result.current.needsAudioResume).toBe(true);
    expect(result.current.error?.kind).toBe("autoplay-blocked");

    playMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.resumeAudio();
    });
    expect(result.current.needsAudioResume).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("reports unsupported browser capabilities without requesting audio", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("ballad");
    });

    await waitFor(() => expect(result.current.connectionState).toBe("error"));
    expect(result.current.error?.kind).toBe("unsupported-browser");
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });

  it("does not expose structured upstream error details", async () => {
    const { stream } = createMicrophone();
    getUserMediaMock.mockResolvedValue(stream);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        error: {
          code: "AZURE_UNAVAILABLE",
          message: "upstream request contained api-key=secret",
          retryable: true,
        },
      }),
    });
    const { result } = renderHook(() => useRealtimeSession());

    await act(async () => {
      await result.current.start("coral");
    });

    expect(result.current.connectionState).toBe("error");
    expect(result.current.error?.kind).toBe("service-error");
    expect(result.current.error?.message).not.toContain("secret");
    expect(JSON.stringify(result.current.diagnostics)).not.toContain("secret");
  });
});
