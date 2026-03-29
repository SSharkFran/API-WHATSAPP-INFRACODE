"use client";

import { useEffect, useState } from "react";
import { requestClientApi } from "../../lib/client-api";
import { Button } from "../ui/Button";

interface TenantApiKeySummary {
  id: string;
  name: string;
  scopes: Array<"read" | "write" | "admin">;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface TenantApiKeyCreateResponse extends TenantApiKeySummary {
  apiKey: string;
}

const fieldClass = [
  "h-11 w-full rounded-[var(--radius-md)] border border-[var(--border-default)]",
  "bg-[var(--bg-tertiary)] px-3 text-sm text-[var(--text-primary)]",
  "placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-blue)]"
].join(" ");

const formatDateTime = (value?: string | null): string =>
  value ? new Date(value).toLocaleString("pt-BR") : "Nunca";

export const ApiKeysManager = () => {
  const [keys, setKeys] = useState<TenantApiKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    expiresAt: "",
    scopes: {
      read: true,
      write: false,
      admin: false
    }
  });

  const loadKeys = async () => {
    setLoading(true);

    try {
      const response = await requestClientApi<TenantApiKeySummary[]>("/tenant/api-keys");
      setKeys(response);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar API keys.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadKeys();
  }, []);

  const createKey = async () => {
    const scopes = (Object.entries(form.scopes) as Array<[keyof typeof form.scopes, boolean]>)
      .filter(([, enabled]) => enabled)
      .map(([scope]) => scope);

    if (!form.name.trim()) {
      setError("Informe um nome para a API key.");
      return;
    }

    if (scopes.length === 0) {
      setError("Selecione ao menos um escopo.");
      return;
    }

    setSubmitting(true);
    setError(null);
    setMessage(null);
    setRevealedKey(null);

    try {
      const created = await requestClientApi<TenantApiKeyCreateResponse>("/tenant/api-keys", {
        method: "POST",
        body: {
          name: form.name.trim(),
          scopes,
          expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined
        }
      });

      setKeys((current) => [created, ...current]);
      setRevealedKey(created.apiKey);
      setMessage("API key criada. Guarde o token agora, ele não será exibido novamente.");
      setForm({
        name: "",
        expiresAt: "",
        scopes: {
          read: true,
          write: false,
          admin: false
        }
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao criar API key.");
    } finally {
      setSubmitting(false);
    }
  };

  const revokeKey = async (id: string) => {
    setError(null);
    setMessage(null);

    try {
      await requestClientApi<void>(`/tenant/api-keys/${id}`, {
        method: "DELETE",
        expectNoContent: true
      });
      setKeys((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                revokedAt: new Date().toISOString()
              }
            : item
        )
      );
      setMessage("API key revogada com sucesso.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao revogar API key.");
    }
  };

  return (
    <div className="space-y-5">
      {error ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--accent-red)]/20 bg-[var(--accent-red)]/8 px-4 py-3 text-sm text-[var(--accent-red)]">
          {error}
        </div>
      ) : null}

      {message ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--accent-green)]/20 bg-[var(--accent-green)]/8 px-4 py-3 text-sm text-[var(--accent-green)]">
          {message}
        </div>
      ) : null}

      {revealedKey ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--accent-blue)]/20 bg-[var(--accent-blue)]/8 p-4">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-sky-200">Token gerado</p>
          <code className="mt-2 block overflow-x-auto rounded-[18px] bg-slate-950/70 px-3 py-3 text-xs text-slate-100">
            {revealedKey}
          </code>
        </div>
      ) : null}

      <div className="grid gap-4 rounded-[26px] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--text-secondary)]">Nome da chave</label>
            <input
              className={fieldClass}
              placeholder="n8n produção"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--text-secondary)]">Expira em</label>
            <input
              type="datetime-local"
              className={fieldClass}
              value={form.expiresAt}
              onChange={(event) => setForm((current) => ({ ...current, expiresAt: event.target.value }))}
            />
          </div>

          <div className="space-y-2 md:col-span-2">
            <p className="text-xs font-medium text-[var(--text-secondary)]">Escopos</p>
            <div className="flex flex-wrap gap-3">
              {(["read", "write", "admin"] as const).map((scope) => (
                <label
                  key={scope}
                  className="flex items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-secondary)]"
                >
                  <input
                    type="checkbox"
                    checked={form.scopes[scope]}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        scopes: {
                          ...current.scopes,
                          [scope]: event.target.checked
                        }
                      }))
                    }
                  />
                  {scope}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => void loadKeys()} disabled={loading || submitting}>
            Atualizar
          </Button>
          <Button onClick={() => void createKey()} loading={submitting}>
            Criar API key
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {loading ? (
          <div className="rounded-[22px] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-5 text-sm text-[var(--text-tertiary)]">
            Carregando API keys...
          </div>
        ) : keys.length === 0 ? (
          <div className="rounded-[22px] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-5 text-sm text-[var(--text-tertiary)]">
            Nenhuma API key criada neste tenant.
          </div>
        ) : (
          keys.map((key) => (
            <div
              key={key.id}
              className="grid gap-4 rounded-[22px] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-4 lg:grid-cols-[1fr_auto]"
            >
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">{key.name}</p>
                  <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-[var(--text-tertiary)]">
                    {key.revokedAt ? "revogada" : "ativa"}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-tertiary)] font-mono">{key.id}</p>
                <p className="text-xs text-[var(--text-secondary)]">Escopos: {key.scopes.join(", ")}</p>
                <p className="text-xs text-[var(--text-tertiary)]">
                  Criada em {formatDateTime(key.createdAt)}. Último uso: {formatDateTime(key.lastUsedAt)}.
                </p>
                <p className="text-xs text-[var(--text-tertiary)]">
                  Expiração: {key.expiresAt ? formatDateTime(key.expiresAt) : "Sem expiração"}.
                </p>
              </div>

              <div className="flex items-start justify-end">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void revokeKey(key.id)}
                  disabled={Boolean(key.revokedAt)}
                >
                  Revogar
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
