"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@infracode/ui";
import { clearBrowserSession, persistBrowserSession, resolveTenantSlugFromBrowserHost } from "../../lib/session";
import { getClientPanelConfig } from "../../lib/client-panel-config";

type LoginMode = "admin" | "tenant";

interface LoginFormProps {
  initialIsAdminDomain: boolean;
}

interface AuthTokensResponse {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
}

const getNetworkErrorMessage = (): string => {
  if (typeof window === "undefined") {
    return "Falha de rede ao conectar com a API.";
  }

  const { hostname, protocol } = window.location;

  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return protocol === "https:"
      ? "Falha de rede ao conectar com a API. Em ambiente local, prefira http://127.0.0.1/login ou configure admin.infracode.local no arquivo hosts."
      : "Falha de rede ao conectar com a API local. Verifique se a stack Docker da InfraCode esta ativa.";
  }

  return "Falha de rede ao conectar com a API.";
};

const parseErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { message?: string };
    return payload.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
};

const baseInputClassName =
  "h-12 w-full rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-4 text-sm text-white outline-none transition-colors placeholder:text-[#444444] focus:border-[#60a5fa] focus:ring-2 focus:ring-[#60a5fa]/20";

export const LoginForm = ({ initialIsAdminDomain }: LoginFormProps) => {
  const [isAdminDomain, setIsAdminDomain] = useState(initialIsAdminDomain);
  const [email, setEmail] = useState("owner@infracode.local");
  const [password, setPassword] = useState("ChangeMe123!");
  const [tenantSlug, setTenantSlug] = useState(() => getClientPanelConfig().tenantSlug);
  const [totpCode, setTotpCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<LoginMode | null>(null);

  useEffect(() => {
    const hostname = window.location.hostname.toLowerCase();
    setIsAdminDomain(hostname.startsWith("admin."));

    const slugFromHost = resolveTenantSlugFromBrowserHost();
    if (slugFromHost) {
      setTenantSlug(slugFromHost);
    }
  }, []);

  const primaryMode: LoginMode = isAdminDomain ? "admin" : "tenant";

  const submit = async (mode: LoginMode) => {
    const apiBaseUrl = getClientPanelConfig().apiBaseUrl;
    const resolvedTenantSlug = tenantSlug.trim() || resolveTenantSlugFromBrowserHost();

    if (mode === "tenant" && !resolvedTenantSlug) {
      setError("Nao foi possivel identificar o slug do tenant para este dominio.");
      return;
    }

    setError(null);
    setPendingMode(mode);

    try {
      const response = await fetch(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email,
          password,
          ...(mode === "tenant" ? { tenantSlug: resolvedTenantSlug } : {}),
          ...(mode === "admin" && totpCode.trim() ? { totpCode: totpCode.trim() } : {}),
          ...(mode === "admin" && backupCode.trim() ? { backupCode: backupCode.trim() } : {})
        })
      });

      if (!response.ok) {
        throw new Error(await parseErrorMessage(response));
      }

      const tokens = (await response.json()) as AuthTokensResponse;
      clearBrowserSession();
      persistBrowserSession({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tenantSlug: mode === "tenant" ? resolvedTenantSlug : undefined
      });

      window.location.assign(mode === "admin" ? "/admin" : "/tenant");
    } catch (caught) {
      if (caught instanceof TypeError) {
        setError(getNetworkErrorMessage());
        return;
      }

      setError(caught instanceof Error ? caught.message : "Falha ao autenticar");
    } finally {
      setPendingMode(null);
    }
  };

  return (
    <div className="rounded-[20px] border border-[#1e1e1e] bg-[#0f0f0f] p-10 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
      <form
        className="space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(primaryMode);
        }}
      >
        <div className="space-y-5">
          <label className="block space-y-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#888888]">Email</span>
            <input
              autoComplete="email"
              className={baseInputClassName}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Endereco de e-mail registrado"
              type="email"
              value={email}
            />
          </label>

          <label className="block space-y-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#888888]">Senha</span>
            <input
              autoComplete={isAdminDomain ? "current-password" : "password"}
              className={baseInputClassName}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Sua chave de acesso"
              type="password"
              value={password}
            />
          </label>

          {isAdminDomain ? (
            <>
              <label className="block space-y-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#888888]">
                  Slug do tenant
                </span>
                <input
                  className={baseInputClassName}
                  onChange={(event) => setTenantSlug(event.target.value)}
                  placeholder="Ex: demo"
                  value={tenantSlug}
                />
              </label>

              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#888888]">
                    TOTP (2FA)
                  </span>
                  <input
                    className={baseInputClassName}
                    inputMode="numeric"
                    onChange={(event) => setTotpCode(event.target.value)}
                    placeholder="000 000"
                    value={totpCode}
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#888888]">
                    Backup
                  </span>
                  <input
                    className={baseInputClassName}
                    onChange={(event) => setBackupCode(event.target.value)}
                    placeholder="Code"
                    value={backupCode}
                  />
                </label>
              </div>
            </>
          ) : null}
        </div>

        {error ? (
          <div
            className="rounded-md border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <div className="space-y-3">
          <Button
            className="h-12 w-full rounded-md border border-[#2563eb] bg-[#2563eb] text-sm font-medium text-white hover:border-[#3b82f6] hover:bg-[#3b82f6] hover:opacity-100 focus-visible:ring-[#60a5fa]"
            disabled={pendingMode !== null}
            type="submit"
          >
            {pendingMode === primaryMode
              ? isAdminDomain
                ? "Autenticando..."
                : "Entrando..."
              : isAdminDomain
                ? "Acessar Super Admin"
                : "Entrar"}
          </Button>

          {isAdminDomain ? (
            <button
              className="w-full rounded-md px-3 py-2 text-sm font-medium text-[#93c5fd] transition-colors hover:text-[#bfdbfe]"
              disabled={pendingMode !== null}
              onClick={() => void submit("tenant")}
              type="button"
            >
              {pendingMode === "tenant" ? "Aguarde..." : "Acessar Painel do Cliente"}
            </button>
          ) : null}
        </div>
      </form>

      <div className="mt-8 flex items-center justify-between gap-4 border-t border-white/6 pt-6">
        <Link
          className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#93c5fd] transition-colors hover:text-[#bfdbfe]"
          href="/redefinir-senha"
        >
          Esqueceu seu acesso?
        </Link>
        <div className="text-[11px] font-medium uppercase tracking-[0.24em] text-white/18">v2.4.1</div>
      </div>
    </div>
  );
};
