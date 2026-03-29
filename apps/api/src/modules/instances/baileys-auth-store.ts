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

  const readData = <TValue>(key: string): TValue | null => {
    const row = selectStmt.get(key) as { value: string } | undefined;

    if (!row) {
      return null;
    }

    return JSON.parse(row.value, BufferJSON.reviver) as TValue;
  };

  const writeData = (key: string, value: unknown | null): void => {
    if (value === null) {
      deleteStmt.run(key);
      return;
    }

    upsertStmt.run(key, JSON.stringify(value, BufferJSON.replacer));
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
        const transaction = db.transaction((payload: SignalDataSet) => {
          for (const [category, values] of Object.entries(
            payload as Record<string, Record<string, unknown | null>>
          )) {
            for (const [id, value] of Object.entries(values ?? {})) {
              writeData(`${category}-${id}`, value ?? null);
            }
          }
        });

        transaction(data);
      }
    }
  };

  return {
    state,
    saveCreds: async () => {
      writeData("creds", state.creds);
    },
    close: () => {
      try {
        db.close();
      } catch (error) {
        console.warn("[baileys-auth-store] falha ao fechar SQLite auth store:", error);
      }
    }
  };
};
