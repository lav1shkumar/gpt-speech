import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseRealtimeSessionResult } from "@/hooks/use-realtime-session";
import { VoiceApp } from "@/components/voice-app";

const { useRealtimeSessionMock, loadConversationMock, saveConversationMock, clearConversationMock } = vi.hoisted(() => ({
  useRealtimeSessionMock: vi.fn(),
  loadConversationMock: vi.fn(),
  saveConversationMock: vi.fn(),
  clearConversationMock: vi.fn(),
}));

vi.mock("@/hooks/use-realtime-session", () => ({
  useRealtimeSession: useRealtimeSessionMock,
}));

vi.mock("@/lib/browser/conversation-store", () => ({
  loadConversation: loadConversationMock,
  saveConversation: saveConversationMock,
  clearConversation: clearConversationMock,
}));

function createSession(
  overrides: Partial<UseRealtimeSessionResult> = {},
): UseRealtimeSessionResult {
  return {
    connectionState: "idle",
    activityState: "listening",
    transcript: [],
    isMuted: false,
    needsAudioResume: false,
    error: null,
    diagnostics: [],
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    toggleMute: vi.fn(),
    resumeAudio: vi.fn().mockResolvedValue(undefined),
    clearTranscript: vi.fn(),
    restoreTranscript: vi.fn(),
    ...overrides,
  } as UseRealtimeSessionResult;
}

describe("VoiceApp", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    loadConversationMock.mockResolvedValue(null);
    saveConversationMock.mockResolvedValue(undefined);
    clearConversationMock.mockResolvedValue(true);
  });

  it("starts a conversation with Coral by default without clearing history", async () => {
    const user = userEvent.setup();
    const session = createSession();
    useRealtimeSessionMock.mockReturnValue(session);
    render(<VoiceApp />);

    expect(screen.getByRole("combobox", { name: "Voice" })).toHaveValue("coral");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start conversation" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start conversation" }));

    expect(session.clearTranscript).not.toHaveBeenCalled();
    expect(session.start).toHaveBeenCalledWith("coral", []);
  });

  it("locks the voice and exposes call controls while connected", async () => {
    const user = userEvent.setup();
    const session = createSession({
      connectionState: "connected",
      activityState: "assistant-speaking",
    });
    useRealtimeSessionMock.mockReturnValue(session);
    render(<VoiceApp />);

    expect(screen.getByRole("combobox", { name: "Voice" })).toBeDisabled();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Speaking" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Mute microphone" }));
    await user.click(screen.getByRole("button", { name: "End conversation" }));

    expect(session.toggleMute).toHaveBeenCalledOnce();
    expect(session.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveFocus();
  });

  it("exposes mute as a stable toggle state", () => {
    useRealtimeSessionMock.mockReturnValue(
      createSession({ connectionState: "connected", isMuted: true }),
    );
    render(<VoiceApp />);

    const muteButton = screen.getByRole("button", { name: "Unmute microphone" });
    expect(muteButton).toHaveAttribute("aria-pressed", "true");
    expect(muteButton).toHaveTextContent("Unmute");
  });

  it("moves focus to status when starting a conversation", async () => {
    const user = userEvent.setup();
    useRealtimeSessionMock.mockReturnValue(createSession());
    render(<VoiceApp />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start conversation" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start conversation" }));

    expect(screen.getByRole("status")).toHaveFocus();
  });

  it("offers one audio recovery action without a duplicate error", async () => {
    const user = userEvent.setup();
    const session = createSession({
      connectionState: "connected",
      needsAudioResume: true,
      error: {
        kind: "autoplay-blocked",
        message: "Tap Resume audio to hear the assistant.",
        retryable: true,
      },
    });
    useRealtimeSessionMock.mockReturnValue(session);
    render(<VoiceApp />);

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("Tap Resume audio to hear the assistant.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Enable sound" }));
    expect(session.resumeAudio).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveFocus();
  });

  it("shows actionable microphone guidance and retries with existing history", async () => {
    const user = userEvent.setup();
    const session = createSession({
      connectionState: "error",
      error: {
        kind: "microphone-denied",
        message: "Microphone access was denied.",
        retryable: true,
      },
    });
    useRealtimeSessionMock.mockReturnValue(session);
    render(<VoiceApp />);

    expect(screen.getByRole("alert")).toHaveTextContent("browser’s site settings");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Voice" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(session.clearTranscript).not.toHaveBeenCalled();
    expect(session.start).toHaveBeenCalledWith("coral", []);
    expect(screen.getByRole("status")).toHaveFocus();
  });

  it("keeps a completed transcript visible after the call ends", async () => {
    const session = createSession({
      transcript: [{ id: "turn-1", role: "assistant", text: "Still here.", status: "complete" }],
    });
    useRealtimeSessionMock.mockReturnValue(session);
    render(<VoiceApp />);

    expect(screen.getByText("Still here.")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue conversation" })).toBeEnabled());
  });

  it("restores the saved voice and transcript without overwriting on mount", async () => {
    const savedTurns = [
      { id: "saved-1", role: "user" as const, text: "Remember this", status: "complete" as const },
      { id: "saved-2", role: "assistant" as const, text: "I will", status: "complete" as const },
    ];
    const restoredTurns = [
      { ...savedTurns[0], id: "user:saved-1" },
      { ...savedTurns[1], id: "assistant:saved-2" },
    ];
    loadConversationMock.mockResolvedValue({ voice: "verse", turns: savedTurns, updatedAt: 123 });
    const session = createSession();
    useRealtimeSessionMock.mockReturnValue(session);

    render(<VoiceApp />);

    await waitFor(() => expect(session.restoreTranscript).toHaveBeenCalledWith(restoredTurns));
    expect(screen.getByRole("combobox", { name: "Voice" })).toHaveValue("verse");
    expect(saveConversationMock).not.toHaveBeenCalled();
  });

  it("saves completed transcript changes locally after storage is loaded", async () => {
    const turns = [
      { id: "turn-1", role: "assistant" as const, text: "Saved locally", status: "complete" as const },
    ];
    useRealtimeSessionMock.mockReturnValue(createSession({ transcript: turns }));

    render(<VoiceApp />);

    await waitFor(() => {
      expect(saveConversationMock).toHaveBeenCalledWith({ voice: "coral", turns });
    });
  });

  it("confirms and resets an active conversation and its local history", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const session = createSession({
      connectionState: "connected",
      transcript: [{ id: "turn-1", role: "user", text: "Clear me", status: "complete" }],
    });
    useRealtimeSessionMock.mockReturnValue(session);
    render(<VoiceApp />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Reset session" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Reset session" }));

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(session.stop).toHaveBeenCalledOnce();
    expect(session.clearTranscript).toHaveBeenCalledOnce();
    await waitFor(() => expect(clearConversationMock).toHaveBeenCalledOnce());
    expect(
      screen.getByText("Conversation reset. The local transcript was cleared."),
    ).toBeVisible();
  });

  it("keeps active history when reset confirmation is cancelled", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const session = createSession({
      transcript: [{ id: "turn-1", role: "assistant", text: "Keep me", status: "complete" }],
    });
    useRealtimeSessionMock.mockReturnValue(session);
    render(<VoiceApp />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Reset session" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Reset session" }));

    expect(session.stop).not.toHaveBeenCalled();
    expect(session.clearTranscript).not.toHaveBeenCalled();
    expect(clearConversationMock).not.toHaveBeenCalled();
  });

  it("keeps the transcript visible and reports when browser deletion fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    clearConversationMock.mockResolvedValue(false);
    const session = createSession({
      transcript: [{ id: "turn-1", role: "user", text: "Keep until deleted", status: "complete" }],
    });
    useRealtimeSessionMock.mockReturnValue(session);
    render(<VoiceApp />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Reset session" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Reset session" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("could not clear");
    });
    expect(session.clearTranscript).not.toHaveBeenCalled();
  });
});
