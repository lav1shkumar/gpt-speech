import { expect, test, type Page } from "@playwright/test";

type RealtimeMockState = {
  dataChannelClosed: boolean;
  getUserMediaCalls: number;
  peerClosed: boolean;
  sentMessages: string[];
  trackEnabled: boolean;
  trackStopped: boolean;
};

declare global {
  interface Window {
    __emitRealtimeEvent?: (event: unknown) => void;
    __realtimeMockState?: RealtimeMockState;
  }
}

const OFFER_SDP = "v=0\r\no=mock-browser 1 1 IN IP4 127.0.0.1\r\ns=mock-offer\r\nt=0 0\r\n";
const ANSWER_SDP = "v=0\r\no=mock-service 1 1 IN IP4 127.0.0.1\r\ns=mock-answer\r\nt=0 0\r\n";

async function installRealtimeBrowserMock(page: Page) {
  await page.addInitScript((offerSdp) => {
    const state: RealtimeMockState = {
      dataChannelClosed: false,
      getUserMediaCalls: 0,
      peerClosed: false,
      sentMessages: [],
      trackEnabled: true,
      trackStopped: false,
    };

    const track = {
      get enabled() {
        return state.trackEnabled;
      },
      set enabled(value: boolean) {
        state.trackEnabled = value;
      },
      stop() {
        state.trackStopped = true;
      },
    };

    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    };

    const channel: {
      onclose: (() => void) | null;
      onerror: (() => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onopen: (() => void) | null;
      readyState: "open" | "closed";
      close: () => void;
      send: (message: string) => void;
    } = {
      onclose: null,
      onerror: null,
      onmessage: null,
      onopen: null,
      readyState: "open",
      close() {
        this.readyState = "closed";
        state.dataChannelClosed = true;
      },
      send(message: string) {
        state.sentMessages.push(message);
      },
    };

    class MockPeerConnection {
      connectionState: RTCPeerConnectionState = "new";
      localDescription: RTCSessionDescriptionInit | null = null;
      onconnectionstatechange: (() => void) | null = null;
      ontrack: (() => void) | null = null;

      addTrack() {
        return {} as RTCRtpSender;
      }

      close() {
        this.connectionState = "closed";
        state.peerClosed = true;
      }

      createDataChannel() {
        return channel as unknown as RTCDataChannel;
      }

      async createOffer(): Promise<RTCSessionDescriptionInit> {
        return { sdp: offerSdp, type: "offer" };
      }

      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description;
      }

      async setRemoteDescription() {
        this.connectionState = "connected";
        queueMicrotask(() => this.onconnectionstatechange?.());
      }
    }

    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      value: MockPeerConnection,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia() {
          state.getUserMediaCalls += 1;
          return stream;
        },
      },
    });
    Object.defineProperty(window, "__realtimeMockState", {
      configurable: true,
      value: state,
    });
    Object.defineProperty(window, "__emitRealtimeEvent", {
      configurable: true,
      value(event: unknown) {
        channel.onmessage?.({ data: JSON.stringify(event) });
      },
    });
  }, OFFER_SDP);
}

async function readRealtimeMockState(page: Page): Promise<RealtimeMockState> {
  return page.evaluate(() => {
    if (!window.__realtimeMockState) {
      throw new Error("Realtime browser mock was not installed");
    }
    return window.__realtimeMockState;
  });
}

async function gotoHydratedApp(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
}

async function emitRealtimeEvent(page: Page, event: unknown) {
  await page.evaluate((nextEvent) => {
    if (!window.__emitRealtimeEvent) {
      throw new Error("Realtime data channel mock was not installed");
    }
    window.__emitRealtimeEvent(nextEvent);
  }, event);
}

async function readSavedTurnTexts(page: Page): Promise<string[] | null> {
  return page.evaluate(async () => {
    const request = indexedDB.open("gpt-speech");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (!database.objectStoreNames.contains("conversation")) {
      database.close();
      return null;
    }

    const transaction = database.transaction("conversation", "readonly");
    const getRequest = transaction.objectStore("conversation").get("active");
    const saved = await new Promise<unknown>((resolve, reject) => {
      getRequest.onsuccess = () => resolve(getRequest.result);
      getRequest.onerror = () => reject(getRequest.error);
    });
    database.close();

    if (typeof saved !== "object" || saved === null || !("turns" in saved)) {
      return null;
    }

    const turns = (saved as { turns?: unknown }).turns;
    if (!Array.isArray(turns)) return null;

    return turns.map((turn) =>
      typeof turn === "object" && turn !== null && "text" in turn
        ? String(turn.text)
        : "",
    );
  });
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      throw new Error(`Browser console error: ${message.text()}`);
    }
  });
  await installRealtimeBrowserMock(page);
});

test("renders an accessible idle call screen without requesting a microphone or session", async ({
  page,
}) => {
  let sessionRequests = 0;
  await page.route("**/api/realtime/session", async (route) => {
    sessionRequests += 1;
    await route.fulfill({ json: { sdp: ANSWER_SDP } });
  });

  await gotoHydratedApp(page);

  await expect(page.getByRole("heading", { level: 1, name: "Talk with GPT" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ready when you are" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transcript" })).toBeVisible();
  await expect(page.getByText("Your conversation will appear here.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start conversation" })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "Voice" })).toHaveValue("coral");
  await expect(page.getByText("Clear and friendly")).toBeVisible();
  await expect(page.getByText("Made by Lavish")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mute microphone" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "End conversation" })).toHaveCount(0);

  expect((await readRealtimeMockState(page)).getUserMediaCalls).toBe(0);
  expect(sessionRequests).toBe(0);
});

test("allows choosing another supported voice before the call", async ({ page }) => {
  await gotoHydratedApp(page);

  const voice = page.getByRole("combobox", { name: "Voice" });
  await expect(voice.locator("option")).toHaveCount(8);
  await voice.selectOption("verse");

  await expect(voice).toHaveValue("verse");
  await expect(page.getByText("Natural and conversational")).toBeVisible();
  expect((await readRealtimeMockState(page)).getUserMediaCalls).toBe(0);
});

test("connects, mutes, and ends through a fully mocked WebRTC session", async ({ page }) => {
  let requestBody: unknown;
  await page.route("**/api/realtime/session", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ sdp: ANSWER_SDP }),
    });
  });
  await gotoHydratedApp(page);

  const voice = page.getByRole("combobox", { name: "Voice" });
  await voice.selectOption("sage");
  await page.getByRole("button", { name: "Start conversation" }).click();

  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Listening" })).toBeVisible();
  await expect(voice).toBeDisabled();
  await expect(page.getByRole("button", { name: "Mute microphone" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "End conversation" })).toBeEnabled();
  expect(requestBody).toEqual({ sdp: OFFER_SDP, voice: "sage" });

  const connectedState = await readRealtimeMockState(page);
  expect(connectedState.getUserMediaCalls).toBe(1);
  expect(connectedState.trackEnabled).toBe(true);

  await page.getByRole("button", { name: "Mute microphone" }).click();
  await expect(page.getByRole("button", { name: "Mute microphone" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect((await readRealtimeMockState(page)).trackEnabled).toBe(false);

  await page.getByRole("button", { name: "End conversation" }).click();
  await expect(page.getByRole("button", { name: "Start conversation" })).toBeEnabled();
  await expect(page.getByText("Offline", { exact: true })).toBeVisible();
  await expect(voice).toBeEnabled();

  const stoppedState = await readRealtimeMockState(page);
  expect(stoppedState.trackStopped).toBe(true);
  expect(stoppedState.dataChannelClosed).toBe(true);
  expect(stoppedState.peerClosed).toBe(true);
});

test("persists completed turns, replays them on continuation, and resets local history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.route("**/api/realtime/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ sdp: ANSWER_SDP }),
    });
  });
  await gotoHydratedApp(page);

  await page.getByRole("combobox", { name: "Voice" }).selectOption("verse");
  await page.getByRole("button", { name: "Start conversation" }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  await emitRealtimeEvent(page, {
    type: "conversation.item.created",
    previous_item_id: null,
    item: { id: "saved-user-1", type: "message", role: "user" },
  });
  await emitRealtimeEvent(page, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "saved-user-1",
    transcript: "What is the speed of light?",
  });
  await emitRealtimeEvent(page, {
    type: "conversation.item.created",
    previous_item_id: "saved-user-1",
    item: { id: "saved-assistant-1", type: "message", role: "assistant" },
  });
  await emitRealtimeEvent(page, {
    type: "response.output_audio_transcript.done",
    item_id: "saved-assistant-1",
    transcript: "About 299,792 kilometers per second in a vacuum.",
  });

  await expect(
    page.getByText("What is the speed of light?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("About 299,792 kilometers per second in a vacuum.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("2 turns")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Voice" })).toHaveValue("verse");

  const transcriptCard = await page.locator(".transcript-card").boundingBox();
  const resetButton = await page.getByRole("button", { name: "Reset session" }).boundingBox();
  expect(transcriptCard).not.toBeNull();
  expect(resetButton).not.toBeNull();
  expect(resetButton!.x + resetButton!.width).toBeLessThanOrEqual(
    transcriptCard!.x + transcriptCard!.width,
  );
  await expect
    .poll(() => readSavedTurnTexts(page))
    .toEqual([
      "What is the speed of light?",
      "About 299,792 kilometers per second in a vacuum.",
    ]);

  await page.getByRole("button", { name: "End conversation" }).click();
  await page.reload({ waitUntil: "networkidle" });

  await expect(
    page.getByText("What is the speed of light?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("About 299,792 kilometers per second in a vacuum.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("2 turns")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Voice" })).toHaveValue("verse");

  await page.getByRole("button", { name: "Continue conversation" }).click();
  await expect(page.getByRole("heading", { name: "Connecting" })).toBeVisible();
  await expect.poll(async () => (await readRealtimeMockState(page)).sentMessages.length).toBe(2);

  const replayedMessages = (await readRealtimeMockState(page)).sentMessages.map(
    (message) => JSON.parse(message) as Record<string, unknown>,
  );
  expect(replayedMessages).toEqual([
    {
      event_id: expect.stringMatching(/^history_replay_0_[a-z0-9]+$/),
      type: "conversation.item.create",
      item: {
        id: "saved-user-1",
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What is the speed of light?" },
        ],
      },
    },
    {
      event_id: expect.stringMatching(/^history_replay_1_[a-z0-9]+$/),
      type: "conversation.item.create",
      previous_item_id: "saved-user-1",
      item: {
        id: "saved-assistant-1",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "About 299,792 kilometers per second in a vacuum.",
          },
        ],
      },
    },
  ]);
  expect(replayedMessages.some((event) => event.type === "response.create")).toBe(false);
  expect((await readRealtimeMockState(page)).trackEnabled).toBe(false);

  await emitRealtimeEvent(page, {
    type: "conversation.item.created",
    previous_item_id: "saved-user-1",
    item: { id: "saved-assistant-1", type: "message", role: "assistant" },
  });
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  expect((await readRealtimeMockState(page)).trackEnabled).toBe(true);

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("permanently clears its transcript from this browser");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Reset session" }).click();
  await expect(page.getByText("Your conversation will appear here.")).toBeVisible();
  await expect(page.getByText("Conversation reset. The local transcript was cleared.")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Voice" })).toHaveValue("verse");
  await expect(
    page.getByText("What is the speed of light?", { exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => readSavedTurnTexts(page)).toBeNull();
  const resetState = await readRealtimeMockState(page);
  expect(resetState.trackStopped).toBe(true);
  expect(resetState.dataChannelClosed).toBe(true);
  expect(resetState.peerClosed).toBe(true);

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText("Your conversation will appear here.")).toBeVisible();
  await expect(
    page.getByText("What is the speed of light?", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start conversation" })).toBeEnabled();
});

test("keeps the primary mobile layout within the viewport and stacks the transcript", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await gotoHydratedApp(page);

  const callCard = page.locator(".call-card");
  const transcriptCard = page.locator(".transcript-card");
  const startButton = page.getByRole("button", { name: "Start conversation" });

  await expect(callCard).toBeVisible();
  await expect(transcriptCard).toBeVisible();
  const [callBox, transcriptBox, buttonBox, dimensions] = await Promise.all([
    callCard.boundingBox(),
    transcriptCard.boundingBox(),
    startButton.boundingBox(),
    page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    })),
  ]);

  expect(callBox).not.toBeNull();
  expect(transcriptBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(transcriptBox!.y).toBeGreaterThan(callBox!.y + callBox!.height - 1);
  expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
  expect(buttonBox!.x).toBeGreaterThanOrEqual(callBox!.x);
  expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(callBox!.x + callBox!.width);
});
