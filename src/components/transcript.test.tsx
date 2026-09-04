import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Transcript } from "@/components/transcript";

describe("Transcript", () => {
  afterEach(cleanup);

  it("announces only a finalized turn, not streaming updates", () => {
    const { container, rerender } = render(
      <Transcript turns={[{ id: "turn-1", role: "assistant", text: "Hello", status: "streaming" }]} />,
    );
    const liveRegion = container.querySelector('[aria-live="polite"]');

    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(liveRegion).toHaveTextContent("");
    expect(
      screen.getByRole("region", { name: "Conversation transcript" }),
    ).toHaveAttribute("tabindex", "0");

    rerender(
      <Transcript turns={[{ id: "turn-1", role: "assistant", text: "Hello there", status: "complete" }]} />,
    );

    expect(liveRegion).toHaveTextContent("GPT: Hello there");
    expect(container.querySelector(".transcript-list")).toHaveAttribute("aria-live", "off");
  });

  it("offers an accessible reset-session control", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(
      <Transcript
        turns={[{ id: "turn-1", role: "user", text: "Hello", status: "complete" }]}
        onReset={onReset}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset session" }));

    expect(onReset).toHaveBeenCalledOnce();
  });

  it("does not pull the user from older turns and resumes following at the bottom", () => {
    const firstTurn = {
      id: "turn-1",
      role: "user" as const,
      text: "First turn",
      status: "complete" as const,
    };
    const { container, rerender } = render(<Transcript turns={[firstTurn]} />);
    const list = container.querySelector(".transcript-list");
    expect(list).toBeInstanceOf(HTMLDivElement);

    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 120, writable: true },
    });
    fireEvent.scroll(list!);

    rerender(
      <Transcript
        turns={[
          firstTurn,
          {
            id: "turn-2",
            role: "assistant",
            text: "New response",
            status: "complete",
          },
        ]}
      />,
    );
    expect(list).toHaveProperty("scrollTop", 120);

    (list as HTMLDivElement).scrollTop = 700;
    fireEvent.scroll(list!);
    Object.defineProperty(list, "scrollHeight", {
      configurable: true,
      value: 1_200,
    });

    rerender(
      <Transcript
        turns={[
          firstTurn,
          {
            id: "turn-2",
            role: "assistant",
            text: "New response",
            status: "complete",
          },
          {
            id: "turn-3",
            role: "user",
            text: "Follow-up",
            status: "complete",
          },
        ]}
      />,
    );
    expect(list).toHaveProperty("scrollTop", 1_200);
  });

  it("resets auto-scroll after the transcript is cleared for a new session", () => {
    const oldTurn = {
      id: "old-turn",
      role: "assistant" as const,
      text: "Old response",
      status: "complete" as const,
    };
    const { container, rerender } = render(<Transcript turns={[oldTurn]} />);
    const list = container.querySelector(".transcript-list") as HTMLDivElement;

    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    fireEvent.scroll(list);

    rerender(<Transcript turns={[]} />);
    expect(list.scrollTop).toBe(0);

    Object.defineProperty(list, "scrollHeight", {
      configurable: true,
      value: 600,
    });
    rerender(
      <Transcript
        turns={[
          {
            id: "new-turn",
            role: "user",
            text: "New conversation",
            status: "complete",
          },
        ]}
      />,
    );

    expect(list.scrollTop).toBe(600);
  });

  it("announces a late user transcript even when it sorts before the assistant", () => {
    const assistantTurn = {
      id: "assistant:item-2",
      role: "assistant" as const,
      text: "Assistant answer",
      status: "complete" as const,
    };
    const { container, rerender } = render(
      <Transcript turns={[assistantTurn]} />,
    );
    const liveRegion = container.querySelector('[aria-live="polite"]');

    expect(liveRegion).toHaveTextContent("GPT: Assistant answer");

    rerender(
      <Transcript
        turns={[
          {
            id: "user:item-1",
            role: "user",
            text: "Late user transcript",
            status: "complete",
          },
          assistantTurn,
        ]}
      />,
    );

    expect(liveRegion).toHaveTextContent("You: Late user transcript");
  });

  it("does not announce restored turns as new activity", () => {
    const restoredTurn = {
      id: "assistant:restored",
      role: "assistant" as const,
      text: "Earlier answer",
      status: "complete" as const,
    };
    const { container } = render(
      <Transcript
        turns={[restoredTurn]}
        silentTurnIds={new Set([restoredTurn.id])}
      />,
    );

    expect(screen.getByText("Earlier answer")).toBeVisible();
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent("");
  });
});
