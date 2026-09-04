import type { ConversationItemLink } from "./events";
import type { TranscriptTurn } from "./types";

export const MAX_REPLAY_TURNS = 24;
export const MAX_REPLAY_CHARACTERS = 12_000;

const MAX_ITEM_ID_LENGTH = 64;
const VALID_ITEM_ID = /^[A-Za-z0-9_-]+$/;

export type ConversationItemCreateEvent = {
  event_id: string;
  type: "conversation.item.create";
  previous_item_id?: string;
  item: {
    id: string;
    type: "message";
    role: TranscriptTurn["role"];
    content: [
      {
        type: "input_text" | "output_text";
        text: string;
      },
    ];
  };
};

export type PreparedConversationHistory = {
  transcript: TranscriptTurn[];
  conversationItems: ConversationItemLink[];
  replayEvents: ConversationItemCreateEvent[];
  replayCharacterCount: number;
};

type PrepareConversationHistoryOptions = {
  maxTurns?: number;
  maxCharacters?: number;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

/**
 * A compact, deterministic hash keeps restored server IDs valid for the
 * client-provided Realtime item ID field when an old ID is malformed or
 * duplicated.
 */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36);
}

function sourceId(turn: TranscriptTurn): string {
  const prefix = `${turn.role}:`;
  return turn.id.startsWith(prefix) ? turn.id.slice(prefix.length) : turn.id;
}

function safeItemId(
  turn: TranscriptTurn,
  index: number,
  usedIds: Set<string>,
): string {
  const candidate = sourceId(turn);

  if (
    candidate.length > 0 &&
    candidate.length <= MAX_ITEM_ID_LENGTH &&
    VALID_ITEM_ID.test(candidate) &&
    !usedIds.has(candidate)
  ) {
    usedIds.add(candidate);
    return candidate;
  }

  const base = `history_${stableHash(`${turn.id}\u0000${turn.role}\u0000${index}`)}`;
  let itemId = base;
  let suffix = 1;

  while (usedIds.has(itemId)) {
    itemId = `${base}_${suffix}`;
    suffix += 1;
  }

  usedIds.add(itemId);
  return itemId;
}

export function normalizeCompletedTranscript(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: TranscriptTurn[] = [];

  value.forEach((candidate) => {
    const record = asRecord(candidate);
    if (!record) return;

    const id = typeof record.id === "string" ? record.id.trim() : "";
    const role = record.role;
    const text = typeof record.text === "string" ? record.text.trim() : "";

    if (
      !id ||
      (role !== "user" && role !== "assistant") ||
      !text ||
      record.status !== "complete"
    ) {
      return;
    }

    normalized.push({ id, role, text, status: "complete" });
  });

  return normalized;
}

function selectReplayTurns(
  transcript: TranscriptTurn[],
  maxTurns: number,
  maxCharacters: number,
): TranscriptTurn[] {
  const selected: TranscriptTurn[] = [];
  let remainingCharacters = maxCharacters;

  for (
    let index = transcript.length - 1;
    index >= 0 && selected.length < maxTurns && remainingCharacters > 0;
    index -= 1
  ) {
    const turn = transcript[index];

    if (turn.text.length <= remainingCharacters) {
      selected.unshift(turn);
      remainingCharacters -= turn.text.length;
      continue;
    }

    // Keep the most recent portion of the boundary turn instead of dropping
    // all context when one transcript is larger than the replay budget.
    const text =
      remainingCharacters === 1
        ? "…"
        : `…${turn.text.slice(-(remainingCharacters - 1))}`;
    selected.unshift({ ...turn, text });
    remainingCharacters = 0;
  }

  return selected;
}

export function prepareConversationHistory(
  value: unknown,
  options: PrepareConversationHistoryOptions = {},
): PreparedConversationHistory {
  const maxTurns = Math.max(
    0,
    Math.floor(options.maxTurns ?? MAX_REPLAY_TURNS),
  );
  const maxCharacters = Math.max(
    0,
    Math.floor(options.maxCharacters ?? MAX_REPLAY_CHARACTERS),
  );
  const normalized = normalizeCompletedTranscript(value);
  const usedIds = new Set<string>();
  let previousItemId: string | null = null;

  const transcript = normalized.map((turn, index) => {
    const itemId = safeItemId(turn, index, usedIds);
    return { ...turn, id: `${turn.role}:${itemId}` };
  });
  const conversationItems = transcript.map((turn) => {
    const id = sourceId(turn);
    const link: ConversationItemLink = { id, previousItemId };
    previousItemId = id;
    return link;
  });
  const replayTurns = selectReplayTurns(
    transcript,
    maxTurns,
    maxCharacters,
  );
  const replayEvents = replayTurns.map((turn, index) => {
    const id = sourceId(turn);
    const previousReplayTurn = replayTurns[index - 1];
    const event: ConversationItemCreateEvent = {
      event_id: `history_replay_${index}_${stableHash(id)}`,
      type: "conversation.item.create",
      item: {
        id,
        type: "message",
        role: turn.role,
        content: [
          {
            type: turn.role === "user" ? "input_text" : "output_text",
            text: turn.text,
          },
        ],
      },
    };

    if (previousReplayTurn) {
      event.previous_item_id = sourceId(previousReplayTurn);
    }

    return event;
  });

  return {
    transcript,
    conversationItems,
    replayEvents,
    replayCharacterCount: replayTurns.reduce(
      (total, turn) => total + turn.text.length,
      0,
    ),
  };
}
