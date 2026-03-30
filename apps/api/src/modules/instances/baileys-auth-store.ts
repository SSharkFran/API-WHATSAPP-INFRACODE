import Database from "better-sqlite3";
import baileys from "@whiskeysockets/baileys";
import type { AuthenticationState, SignalDataSet, SignalDataTypeMap } from "@whiskeysockets/baileys";

const { BufferJSON, initAuthCreds, proto } = baileys;

export interface SqliteAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  close: () => void;
}

/**
 * Persiste credenciais e chaves Signal em um SQLite por instancia.
 */
export const useSqliteAuthState = async (databasePath: string): Promise<SqliteAuthState> => {
  const db = new Database(databasePath);
  let closed = false;
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const selectStmt = db.prepare("SELECT value FROM auth_state WHERE key = ?");
  const upsertStmt = db.prepare(`
    INSERT INTO auth_state (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const deleteStmt = db.prepare("DELETE FROM auth_state WHERE key = ?");

  const isClosedConnectionError = (error: unknown): boolean =>
    error instanceof Error && /database connection is not open/i.test(error.message);

  const markClosed = (): void => {
    closed = true;
  };

  const readData = <TValue>(key: string): TValue | null => {
    if (closed) {
      return null;
    }

    let row: { value: string } | undefined;
    try {
      row = selectStmt.get(key) as { value: string } | undefined;
    } catch (error) {
      if (isClosedConnectionError(error)) {
        markClosed();
        console.warn("[baileys-auth-store] leitura ignorada apos fechamento do SQLite auth store");
        return null;
      }

      throw error;
    }

    if (!row) {
      return null;
    }

    return JSON.parse(row.value, BufferJSON.reviver) as TValue;
  };

  const writeData = (key: string, value: unknown | null): void => {
    if (closed) {
      return;
    }

    if (value === null) {
      try {
        deleteStmt.run(key);
      } catch (error) {
        if (isClosedConnectionError(error)) {
          markClosed();
          console.warn("[baileys-auth-store] remocao ignorada apos fechamento do SQLite auth store");
          return;
        }

        throw error;
      }
      return;
    }

    try {
      upsertStmt.run(key, JSON.stringify(value, BufferJSON.replacer));
    } catch (error) {
      if (isClosedConnectionError(error)) {
        markClosed();
        console.warn("[baileys-auth-store] gravacao ignorada apos fechamento do SQLite auth store");
        return;
      }

      throw error;
    }
  };

  const creds = readData<AuthenticationState["creds"]>("creds") ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <TKey extends keyof SignalDataTypeMap>(
        type: TKey,
        ids: string[]
      ): Promise<{ [id: string]: SignalDataTypeMap[TKey] }> => {
        const result: Record<string, SignalDataTypeMap[TKey]> = {};

        for (const id of ids) {
          const key = `${String(type)}-${id}`;
          let value = readData<SignalDataTypeMap[TKey]>(key);

          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as object) as unknown as SignalDataTypeMap[TKey];
          }

          if (value) {
            result[id] = value;
          }
        }

        return result;
      },
      set: async (data: SignalDataSet): Promise<void> => {
        if (closed) {
          return;
        }

        const transaction = db.transaction((payload: SignalDataSet) => {
          for (const [category, values] of Object.entries(
            payload as Record<string, Record<string, unknown | null>>
          )) {
            for (const [id, value] of Object.entries(values ?? {})) {
              writeData(`${category}-${id}`, value ?? null);
            }
          }
        });

        try {
          transaction(data);
        } catch (error) {
          if (isClosedConnectionError(error)) {
            markClosed();
            console.warn("[baileys-auth-store] transacao ignorada apos fechamento do SQLite auth store");
            return;
          }

          throw error;
        }
      }
    }
  };

  return {
    state,
    saveCreds: async () => {
      writeData("creds", state.creds);
    },
    close: () => {
      if (closed) {
        return;
      }

      markClosed();
      try {
        db.close();
      } catch (error) {
        console.warn("[baileys-auth-store] falha ao fechar SQLite auth store:", error);
      }
    }
  };
};
