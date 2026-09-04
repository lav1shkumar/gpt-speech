import type { ActivityState, TranscriptTurn } from "./types";

export type RealtimeProtocolIssue =
  | "service-error"
  | "transcription-failed";

export type RealtimeEventState = {
  activityState: ActivityState;
  transcript: TranscriptTurn[];
  protocolIssue: RealtimeProtocolIssue | null;
  userSpeechActive: boolean;
  outputAudioActive: boolean;
  conversationItems: ConversationItemLink[];
  seenEventIds: string[];
};

export type ConversationItemLink = {
  id: string;
  previousItemId: string | null;
};

export type RealtimeEventAction =
  | { type: "server-event"; event: unknown }
  | { type: "clear-transcript" }
  | { type: "reset-session" }
  | { type: "session-stopped" };

export const createInitialRealtimeEventState = (): RealtimeEventState => ({
  activityState: "listening",
  transcript: [],
  protocolIssue: null,
  userSpeechActive: false,
  outputAudioActive: false,
  conversationItems: [],
  seenEventIds: [],
});

const MAX_SEEN_EVENT_IDS = 512;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

function stringField(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

export function getRealtimeEventType(event: unknown): string | null {
  const record = asRecord(event);
  return record ? stringField(record, "type") : null;
}

export function getRealtimeProtocolIssue(
  event: unknown,
): RealtimeProtocolIssue | null {
  const type = getRealtimeEventType(event);

  if (type === "error") {
    return "service-error";
  }

  if (type === "conversation.item.input_audio_transcription.failed") {
    return "transcription-failed";
  }

  return null;
}

function turnIdentifier(
  event: UnknownRecord,
  role: TranscriptTurn["role"],
): string | null {
  const sourceId =
    stringField(event, "item_id") ??
    stringField(event, "response_id");

  return sourceId ? `${role}:${sourceId}` : null;
}

function turnSourceId(turn: TranscriptTurn): string {
  return turn.id.slice(turn.role.length + 1);
}

function orderTranscript(
  transcript: TranscriptTurn[],
  conversationItems: ConversationItemLink[],
): TranscriptTurn[] {
  if (transcript.length < 2 || conversationItems.length === 0) {
    return transcript;
  }

  const knownIds = new Set(conversationItems.map((item) => item.id));
  const children = new Map<string | null, string[]>();

  conversationItems.forEach((item) => {
    const parent =
      item.previousItemId && knownIds.has(item.previousItemId)
        ? item.previousItemId
        : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(item.id);
    children.set(parent, siblings);
  });

  const orderedIds: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    orderedIds.push(id);
    children.get(id)?.forEach(visit);
  };

  children.get(null)?.forEach(visit);
  conversationItems.forEach((item) => visit(item.id));

  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  return transcript
    .map((turn, arrivalIndex) => ({ turn, arrivalIndex }))
    .sort((left, right) => {
      const leftRank = rank.get(turnSourceId(left.turn));
      const rightRank = rank.get(turnSourceId(right.turn));

      if (leftRank === undefined && rightRank === undefined) {
        return left.arrivalIndex - right.arrivalIndex;
      }
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    })
    .map(({ turn }) => turn);
}

function addConversationItem(
  state: RealtimeEventState,
  event: UnknownRecord,
): RealtimeEventState {
  const item = asRecord(event.item);
  const id = item ? stringField(item, "id") : null;
  if (!id) {
    return state;
  }

  const existingIndex = state.conversationItems.findIndex(
    (candidate) => candidate.id === id,
  );
  const previousValue = event.previous_item_id;
  const previousItemId =
    typeof previousValue === "string"
      ? previousValue
      : previousValue === null
        ? null
        : existingIndex === -1
          ? null
          : state.conversationItems[existingIndex].previousItemId;
  const link: ConversationItemLink = { id, previousItemId };
  let conversationItems: ConversationItemLink[];

  if (existingIndex === -1) {
    conversationItems = [...state.conversationItems, link];
  } else {
    const existing = state.conversationItems[existingIndex];
    if (existing.previousItemId === previousItemId) {
      return state;
    }
    conversationItems = [...state.conversationItems];
    conversationItems[existingIndex] = link;
  }

  return {
    ...state,
    conversationItems,
    transcript: orderTranscript(state.transcript, conversationItems),
  };
}

function addCompletedUserTurn(
  transcript: TranscriptTurn[],
  event: UnknownRecord,
): TranscriptTurn[] {
  const text = stringField(event, "transcript")?.trim();
  const id = turnIdentifier(event, "user");

  if (!id || !text) {
    return transcript;
  }

  const existingIndex = transcript.findIndex((turn) => turn.id === id);
  const completedTurn: TranscriptTurn = {
    id,
    role: "user",
    text,
    status: "complete",
  };

  if (existingIndex === -1) {
    return [...transcript, completedTurn];
  }

  const next = [...transcript];
  next[existingIndex] = completedTurn;
  return next;
}

function addAssistantDelta(
  transcript: TranscriptTurn[],
  event: UnknownRecord,
): TranscriptTurn[] {
  const delta = stringField(event, "delta");
  const id = turnIdentifier(event, "assistant");

  if (!id || !delta) {
    return transcript;
  }

  const existingIndex = transcript.findIndex((turn) => turn.id === id);

  if (existingIndex === -1) {
    return [
      ...transcript,
      { id, role: "assistant", text: delta, status: "streaming" },
    ];
  }

  const existing = transcript[existingIndex];
  if (existing.status === "complete") {
    return transcript;
  }

  const next = [...transcript];
  next[existingIndex] = { ...existing, text: `${existing.text}${delta}` };
  return next;
}

function completeAssistantTurn(
  transcript: TranscriptTurn[],
  event: UnknownRecord,
): TranscriptTurn[] {
  const id = turnIdentifier(event, "assistant");
  if (!id) {
    return transcript;
  }

  const suppliedText = stringField(event, "transcript")?.trim() || null;
  const existingIndex = transcript.findIndex((turn) => turn.id === id);

  if (existingIndex === -1) {
    if (!suppliedText) {
      return transcript;
    }

    return [
      ...transcript,
      {
        id,
        role: "assistant",
        text: suppliedText,
        status: "complete",
      },
    ];
  }

  const existing = transcript[existingIndex];
  const next = [...transcript];
  next[existingIndex] = {
    ...existing,
    text: suppliedText ?? existing.text,
    status: "complete",
  };
  return next;
}

function interruptStreamingTurns(transcript: TranscriptTurn[]): TranscriptTurn[] {
  let changed = false;
  const next = transcript.map((turn) => {
    if (turn.status === "complete") {
      return turn;
    }

    changed = true;
    return { ...turn, status: "interrupted" as const };
  });

  return changed ? next : transcript;
}

function completeResponseTurns(
  transcript: TranscriptTurn[],
  event: UnknownRecord,
): TranscriptTurn[] {
  const response = asRecord(event.response);
  if (!response) {
    return transcript;
  }

  const responseItemIds = new Set<string>();
  const responseId = stringField(response, "id");
  if (responseId) {
    responseItemIds.add(responseId);
  }

  if (Array.isArray(response.output)) {
    response.output.forEach((value) => {
      const item = asRecord(value);
      const itemId = item ? stringField(item, "id") : null;
      if (itemId) {
        responseItemIds.add(itemId);
      }
    });
  }

  if (responseItemIds.size === 0) {
    return transcript;
  }

  let changed = false;
  const next = transcript.map((turn) => {
    if (
      turn.role !== "assistant" ||
      turn.status === "complete" ||
      !responseItemIds.has(turnSourceId(turn))
    ) {
      return turn;
    }

    changed = true;
    return { ...turn, status: "complete" as const };
  });

  return changed ? next : transcript;
}

function reduceServerEvent(
  state: RealtimeEventState,
  event: unknown,
): RealtimeEventState {
  const record = asRecord(event);
  const type = getRealtimeEventType(event);

  if (!record || !type) {
    return state;
  }

  const eventId = stringField(record, "event_id");
  if (eventId && state.seenEventIds.includes(eventId)) {
    return state;
  }

  let nextState: RealtimeEventState;

  switch (type) {
    case "input_audio_buffer.speech_started":
      nextState = {
        ...state,
        activityState: "user-speaking",
        userSpeechActive: true,
      };
      break;

    case "input_audio_buffer.speech_stopped":
      nextState = {
        ...state,
        activityState: state.outputAudioActive
          ? "assistant-speaking"
          : "assistant-thinking",
        userSpeechActive: false,
      };
      break;

    case "output_audio_buffer.started":
      nextState = {
        ...state,
        activityState: state.userSpeechActive
          ? "user-speaking"
          : "assistant-speaking",
        outputAudioActive: true,
      };
      break;

    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      nextState = {
        ...state,
        activityState: state.userSpeechActive
          ? "user-speaking"
          : state.activityState === "assistant-thinking"
            ? "assistant-thinking"
            : "listening",
        outputAudioActive: false,
      };
      break;

    case "conversation.item.input_audio_transcription.completed": {
      const transcript = addCompletedUserTurn(state.transcript, record);
      if (transcript === state.transcript) return state;
      nextState = {
        ...state,
        transcript: orderTranscript(transcript, state.conversationItems),
      };
      break;
    }

    case "response.output_audio_transcript.delta": {
      const transcript = addAssistantDelta(state.transcript, record);
      if (transcript === state.transcript) return state;
      nextState = {
        ...state,
        transcript: orderTranscript(transcript, state.conversationItems),
      };
      break;
    }

    case "response.output_audio_transcript.done": {
      const transcript = completeAssistantTurn(state.transcript, record);
      if (transcript === state.transcript) return state;
      nextState = {
        ...state,
        transcript: orderTranscript(transcript, state.conversationItems),
      };
      break;
    }

    case "conversation.item.added":
    case "conversation.item.created":
      nextState = addConversationItem(state, record);
      if (nextState === state) return state;
      break;

    case "response.done":
      nextState = {
        ...state,
        activityState: state.userSpeechActive
          ? "user-speaking"
          : state.outputAudioActive
            ? "assistant-speaking"
            : "listening",
        transcript: completeResponseTurns(state.transcript, record),
      };
      break;

    case "conversation.item.input_audio_transcription.failed":
      nextState = { ...state, protocolIssue: "transcription-failed" };
      break;

    case "error":
      nextState = {
        ...state,
        activityState: state.userSpeechActive
          ? "user-speaking"
          : state.outputAudioActive
            ? "assistant-speaking"
            : "listening",
        protocolIssue: "service-error",
      };
      break;

    default:
      return state;
  }

  if (!eventId) {
    return nextState;
  }

  return {
    ...nextState,
    seenEventIds: [
      ...state.seenEventIds.slice(-(MAX_SEEN_EVENT_IDS - 1)),
      eventId,
    ],
  };
}

export function realtimeEventReducer(
  state: RealtimeEventState,
  action: RealtimeEventAction,
): RealtimeEventState {
  switch (action.type) {
    case "server-event":
      return reduceServerEvent(state, action.event);

    case "clear-transcript":
      return state.transcript.length === 0 ? state : { ...state, transcript: [] };

    case "reset-session":
      return createInitialRealtimeEventState();

    case "session-stopped":
      return {
        ...state,
        activityState: "listening",
        protocolIssue: null,
        userSpeechActive: false,
        outputAudioActive: false,
        transcript: interruptStreamingTurns(state.transcript),
      };
  }
}
