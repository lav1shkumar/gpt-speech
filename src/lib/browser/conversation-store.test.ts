import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranscriptTurn } from "@/lib/realtime/types";

import {
  clearConversation,
  loadConversation,
  saveConversation,
} from "./conversation-store";

type Handler = (() => void) | null;

class FakeRequest<T = unknown> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: DOMException | null = null;

  constructor(private readonly records: Map<IDBValidKey, unknown>) {}

  objectStore(): IDBObjectStore {
    return new FakeObjectStore(this.records, this) as unknown as IDBObjectStore;
  }

  complete(): void {
    queueMicrotask(() => this.oncomplete?.());
  }
}

class FakeObjectStore {
  constructor(
    private readonly records: Map<IDBValidKey, unknown>,
    private readonly transaction: FakeTransaction,
  ) {}

  get(key: IDBValidKey): IDBRequest {
    const request = new FakeRequest();
    queueMicrotask(() => {
      request.result = this.records.get(key);
      request.onsuccess?.();
      this.transaction.complete();
    });
    return request as unknown as IDBRequest;
  }

  put(value: unknown, key: IDBValidKey): IDBRequest {
    const request = new FakeRequest();
    queueMicrotask(() => {
      this.records.set(key, structuredClone(value));
      request.result = key;
      request.onsuccess?.();
      this.transaction.complete();
    });
    return request as unknown as IDBRequest;
  }

  delete(key: IDBValidKey): IDBRequest {
    const request = new FakeRequest();
    queueMicrotask(() => {
      this.records.delete(key);
      request.result = undefined;
      request.onsuccess?.();
      this.transaction.complete();
    });
    return request as unknown as IDBRequest;
  }
}

class FakeDatabase {
  readonly records = new Map<IDBValidKey, unknown>();
  private readonly storeNames = new Set<string>();
  failTransactions = false;

  readonly objectStoreNames = {
    contains: (name: string) => this.storeNames.has(name),
  } as DOMStringList;

  createObjectStore(name: string): IDBObjectStore {
    this.storeNames.add(name);
    return {} as IDBObjectStore;
  }

  transaction(): IDBTransaction {
    if (this.failTransactions) {
      throw new DOMException("Storage is unavailable", "InvalidStateError");
    }

    return new FakeTransaction(this.records) as unknown as IDBTransaction;
  }

  close(): void {}
}

class FakeOpenRequest extends FakeRequest<IDBDatabase> {
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
  transaction: IDBTransaction | null = null;
}

class FakeIndexedDbFactory {
  readonly database = new FakeDatabase();
  throwOnOpen = false;
  private initialized = false;

  open(): IDBOpenDBRequest {
    if (this.throwOnOpen) {
      throw new DOMException("Storage is unavailable", "SecurityError");
    }

    const request = new FakeOpenRequest();
    queueMicrotask(() => {
      request.result = this.database as unknown as IDBDatabase;
      if (!this.initialized) {
        this.initialized = true;
        request.onupgradeneeded?.();
      }
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

function installFakeIndexedDb(): FakeIndexedDbFactory {
  const factory = new FakeIndexedDbFactory();
  vi.stubGlobal("indexedDB", factory as unknown as IDBFactory);
  return factory;
}

function completedTurn(index: number, text = `Turn ${index}`): TranscriptTurn {
  return {
    id: `turn-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    status: "complete",
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("conversation-store", () => {
  it("saves and loads a validated conversation with its timestamp", async () => {
    installFakeIndexedDb();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));

    await saveConversation({
      voice: "coral",
      turns: [completedTurn(1, "  Hello there  ")],
    });

    await expect(loadConversation()).resolves.toEqual({
      voice: "coral",
      turns: [completedTurn(1, "Hello there")],
      updatedAt: Date.parse("2026-09-04T12:00:00.000Z"),
    });
  });

  it("keeps only the latest 100 completed, non-empty turns", async () => {
    installFakeIndexedDb();
    const completedTurns = Array.from({ length: 105 }, (_, index) =>
      completedTurn(index),
    );

    await saveConversation({
      voice: "verse",
      turns: [
        ...completedTurns,
        { ...completedTurn(106), status: "streaming" },
        completedTurn(107, "   "),
      ],
    });

    const stored = await loadConversation();
    expect(stored?.turns).toHaveLength(100);
    expect(stored?.turns.at(0)?.id).toBe("turn-5");
    expect(stored?.turns.at(-1)?.id).toBe("turn-104");
    expect(stored?.turns.every((turn) => turn.status === "complete")).toBe(true);
  });

  it("caps individual and total transcript text size", async () => {
    installFakeIndexedDb();

    await saveConversation({
      voice: "alloy",
      turns: Array.from({ length: 100 }, (_, index) =>
        completedTurn(index, "x".repeat(index === 99 ? 20_000 : 6_000)),
      ),
    });

    const stored = await loadConversation();
    const totalCharacters =
      stored?.turns.reduce((total, turn) => total + turn.text.length, 0) ?? 0;

    expect(stored?.turns.at(-1)?.text).toHaveLength(12_000);
    expect(totalCharacters).toBeLessThanOrEqual(500_000);
    expect(stored?.turns.length).toBeLessThan(100);
  });

  it("clears the saved conversation", async () => {
    installFakeIndexedDb();
    await saveConversation({ voice: "ash", turns: [completedTurn(1)] });

    await expect(clearConversation()).resolves.toBe(true);

    await expect(loadConversation()).resolves.toBeNull();
  });

  it("rejects a corrupt record and sanitizes invalid nested turns", async () => {
    const factory = installFakeIndexedDb();
    await saveConversation({ voice: "sage", turns: [completedTurn(1)] });

    factory.database.records.set("active", {
      voice: "not-a-voice",
      turns: [],
      updatedAt: Date.now(),
    });
    await expect(loadConversation()).resolves.toBeNull();

    factory.database.records.set("active", {
      voice: "sage",
      turns: [
        completedTurn(2),
        { ...completedTurn(3), role: "system" },
        { ...completedTurn(4), id: "" },
      ],
      updatedAt: 123,
    });
    await expect(loadConversation()).resolves.toEqual({
      voice: "sage",
      turns: [completedTurn(2)],
      updatedAt: 123,
    });
  });

  it("resolves safely when IndexedDB is absent or throws", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(loadConversation()).resolves.toBeNull();
    await expect(
      saveConversation({ voice: "coral", turns: [completedTurn(1)] }),
    ).resolves.toBeUndefined();
    await expect(clearConversation()).resolves.toBe(false);

    const factory = installFakeIndexedDb();
    factory.throwOnOpen = true;
    await expect(loadConversation()).resolves.toBeNull();
    await expect(
      saveConversation({ voice: "coral", turns: [completedTurn(1)] }),
    ).resolves.toBeUndefined();
    await expect(clearConversation()).resolves.toBe(false);
  });

  it("resolves safely when an IndexedDB transaction fails", async () => {
    const factory = installFakeIndexedDb();
    await saveConversation({ voice: "echo", turns: [completedTurn(1)] });
    factory.database.failTransactions = true;

    await expect(loadConversation()).resolves.toBeNull();
    await expect(
      saveConversation({ voice: "echo", turns: [completedTurn(2)] }),
    ).resolves.toBeUndefined();
    await expect(clearConversation()).resolves.toBe(false);
  });
});
