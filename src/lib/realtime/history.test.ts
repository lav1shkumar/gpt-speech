import { describe, expect, it } from "vitest";

import type { TranscriptTurn } from "./types";
import {
  normalizeCompletedTranscript,
  prepareConversationHistory,
} from "./history";

function turn(
  id: string,
  role: TranscriptTurn["role"],
  text: string,
  status: TranscriptTurn["status"] = "complete",
): TranscriptTurn {
  return { id, role, text, status };
}

describe("normalizeCompletedTranscript", () => {
  it("keeps only completed, nonempty, structurally valid turns", () => {
    expect(
      normalizeCompletedTranscript([
        turn("user:first", "user", "  Hello  "),
        turn("assistant:partial", "assistant", "Not finished", "streaming"),
        turn("assistant:empty", "assistant", "   "),
        { id: "system:bad-role", role: "system", text: "No", status: "complete" },
        { id: 42, role: "user", text: "No", status: "complete" },
        null,
        turn("assistant:second", "assistant", "Hi"),
      ]),
    ).toEqual([
      turn("user:first", "user", "Hello"),
      turn("assistant:second", "assistant", "Hi"),
    ]);
  });

  it("returns an empty transcript for non-array input", () => {
    expect(normalizeCompletedTranscript({ transcript: [] })).toEqual([]);
  });
});

describe("prepareConversationHistory", () => {
  it("creates ordered user input and assistant output items without a response", () => {
    const prepared = prepareConversationHistory([
      turn("user:item_user", "user", "Hello"),
      turn("assistant:item_assistant", "assistant", "Hi there"),
    ]);

    expect(prepared.transcript.map(({ id }) => id)).toEqual([
      "user:item_user",
      "assistant:item_assistant",
    ]);
    expect(prepared.conversationItems).toEqual([
      { id: "item_user", previousItemId: null },
      { id: "item_assistant", previousItemId: "item_user" },
    ]);
    expect(prepared.replayEvents).toEqual([
      {
        event_id: expect.stringMatching(/^history_replay_0_[a-z0-9]+$/),
        type: "conversation.item.create",
        item: {
          id: "item_user",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      },
      {
        event_id: expect.stringMatching(/^history_replay_1_[a-z0-9]+$/),
        type: "conversation.item.create",
        previous_item_id: "item_user",
        item: {
          id: "item_assistant",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi there" }],
        },
      },
    ]);
    expect(
      prepared.replayEvents.some(
        (event) => (event as { type: string }).type === "response.create",
      ),
    ).toBe(false);
    expect(new Set(prepared.replayEvents.map((event) => event.event_id)).size).toBe(
      prepared.replayEvents.length,
    );
  });

  it("uses the most recent turns and stays within both replay limits", () => {
    const prepared = prepareConversationHistory(
      [
        turn("user:one", "user", "1111"),
        turn("assistant:two", "assistant", "2222"),
        turn("user:three", "user", "3333"),
        turn("assistant:four", "assistant", "4444"),
      ],
      { maxTurns: 3, maxCharacters: 9 },
    );

    expect(prepared.transcript).toHaveLength(4);
    expect(
      prepared.replayEvents.map((event) => event.item.content[0].text),
    ).toEqual(["…", "3333", "4444"]);
    expect(prepared.replayCharacterCount).toBe(9);
    expect(prepared.replayEvents).toHaveLength(3);
  });

  it("uses a stable valid fallback for malformed or duplicate source IDs", () => {
    const first = prepareConversationHistory([
      turn("user:id with spaces", "user", "One"),
      turn("assistant:id with spaces", "assistant", "Two"),
      turn("user:duplicate", "user", "Three"),
      turn("assistant:duplicate", "assistant", "Four"),
    ]);
    const second = prepareConversationHistory([
      turn("user:id with spaces", "user", "One"),
      turn("assistant:id with spaces", "assistant", "Two"),
      turn("user:duplicate", "user", "Three"),
      turn("assistant:duplicate", "assistant", "Four"),
    ]);

    const ids = first.replayEvents.map((event) => event.item.id);
    expect(ids).toEqual(second.replayEvents.map((event) => event.item.id));
    expect(new Set(ids)).toHaveProperty("size", ids.length);
    ids.forEach((id) => expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/));
  });

  it("returns no replay events when there is no usable history", () => {
    const prepared = prepareConversationHistory([
      turn("user:partial", "user", "Still speaking", "streaming"),
      turn("assistant:blank", "assistant", " "),
    ]);

    expect(prepared.transcript).toEqual([]);
    expect(prepared.conversationItems).toEqual([]);
    expect(prepared.replayEvents).toEqual([]);
    expect(prepared.replayCharacterCount).toBe(0);
  });
});
