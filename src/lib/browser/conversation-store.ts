import { VOICES, type TranscriptTurn, type VoiceId } from "@/lib/realtime/types";

const DATABASE_NAME = "gpt-speech";
const DATABASE_VERSION = 1;
const STORE_NAME = "conversation";
const ACTIVE_CONVERSATION_KEY = "active";

const MAX_TURNS = 100;
const MAX_TURN_TEXT_LENGTH = 12_000;
const MAX_TOTAL_TEXT_LENGTH = 500_000;
const MAX_TURN_ID_LENGTH = 512;

const VOICE_IDS = new Set<string>(VOICES.map((voice) => voice.id));
let mutationQueue: Promise<unknown> = Promise.resolve();

export type StoredConversation = {
  voice: VoiceId;
  turns: TranscriptTurn[];
  updatedAt: number;
};

type ConversationInput = Pick<StoredConversation, "voice" | "turns">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isVoiceId(value: unknown): value is VoiceId {
  return typeof value === "string" && VOICE_IDS.has(value);
}

function sanitizeTurn(value: unknown): TranscriptTurn | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const role = value.role;
  const status = value.status;
  const rawText = typeof value.text === "string" ? value.text.trim() : "";

  if (
    id.length === 0 ||
    id.length > MAX_TURN_ID_LENGTH ||
    (role !== "user" && role !== "assistant") ||
    status !== "complete" ||
    rawText.length === 0
  ) {
    return null;
  }

  const text = rawText.slice(0, MAX_TURN_TEXT_LENGTH).trim();
  if (text.length === 0) {
    return null;
  }

  return { id, role, text, status: "complete" };
}

function sanitizeTurns(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const newestFirst: TranscriptTurn[] = [];
  let totalTextLength = 0;

  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (newestFirst.length === MAX_TURNS) {
      break;
    }

    const turn = sanitizeTurn(value[index]);
    if (!turn) {
      continue;
    }

    if (totalTextLength + turn.text.length > MAX_TOTAL_TEXT_LENGTH) {
      break;
    }

    newestFirst.push(turn);
    totalTextLength += turn.text.length;
  }

  return newestFirst.reverse();
}

function parseStoredConversation(value: unknown): StoredConversation | null {
  if (
    !isRecord(value) ||
    !isVoiceId(value.voice) ||
    !Array.isArray(value.turns) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt < 0
  ) {
    return null;
  }

  return {
    voice: value.voice,
    turns: sanitizeTurns(value.turns),
    updatedAt: value.updatedAt,
  };
}

function closeDatabase(database: IDBDatabase): void {
  try {
    database.close();
  } catch {
    // A broken or partially initialized IndexedDB implementation is non-fatal.
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  let factory: IDBFactory | undefined;
  try {
    factory = globalThis.indexedDB;
  } catch {
    return Promise.resolve(null);
  }

  if (!factory) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        if (database) {
          closeDatabase(database);
        }
        return;
      }

      settled = true;
      resolve(database);
    };

    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    } catch {
      finish(null);
      return;
    }

    request.onupgradeneeded = () => {
      try {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      } catch {
        try {
          request.transaction?.abort();
        } catch {
          // The error/abort handlers below will resolve the operation safely.
        }
      }
    };

    request.onsuccess = () => {
      try {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          closeDatabase(database);
          finish(null);
          return;
        }

        finish(database);
      } catch {
        finish(null);
      }
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
}

export async function loadConversation(): Promise<StoredConversation | null> {
  const database = await openDatabase();
  if (!database) {
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (value: StoredConversation | null) => {
      if (settled) {
        return;
      }

      settled = true;
      closeDatabase(database);
      resolve(value);
    };

    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(ACTIVE_CONVERSATION_KEY);
      let storedValue: unknown;

      request.onsuccess = () => {
        storedValue = request.result;
      };
      request.onerror = () => finish(null);
      transaction.oncomplete = () => {
        try {
          finish(parseStoredConversation(storedValue));
        } catch {
          finish(null);
        }
      };
      transaction.onerror = () => finish(null);
      transaction.onabort = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

async function saveConversationNow({
  voice,
  turns,
}: ConversationInput): Promise<void> {
  let conversation: StoredConversation;
  try {
    if (!isVoiceId(voice)) {
      return;
    }

    conversation = {
      voice,
      turns: sanitizeTurns(turns),
      updatedAt: Date.now(),
    };
  } catch {
    return;
  }

  const database = await openDatabase();
  if (!database) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      closeDatabase(database);
      resolve();
    };

    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction
        .objectStore(STORE_NAME)
        .put(conversation, ACTIVE_CONVERSATION_KEY);
      transaction.oncomplete = finish;
      transaction.onerror = finish;
      transaction.onabort = finish;
    } catch {
      finish();
    }
  });
}

async function clearConversationNow(): Promise<boolean> {
  const database = await openDatabase();
  if (!database) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const finish = (cleared: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      closeDatabase(database);
      resolve(cleared);
    };

    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(ACTIVE_CONVERSATION_KEY);
      transaction.oncomplete = () => finish(true);
      transaction.onerror = () => finish(false);
      transaction.onabort = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

function enqueueMutation<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const queuedOperation = mutationQueue.then(operation, operation);
  mutationQueue = queuedOperation.then(
    () => undefined,
    () => undefined,
  );
  return queuedOperation;
}

export function saveConversation(input: ConversationInput): Promise<void> {
  return enqueueMutation(() => saveConversationNow(input));
}

export function clearConversation(): Promise<boolean> {
  return enqueueMutation(clearConversationNow);
}
