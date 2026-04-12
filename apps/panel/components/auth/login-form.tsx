"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@infracode/ui";
import { clearBrowserSession, persistBrowserSession } from "../../lib/session";
import { getClientPanelConfig } from "../../lib/client-panel-config";

interface AuthTokensResponse {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
  tenantSlug: string | null;
  role: string | null;
  redirectTo: "/admin" | "/tenant";
}

const getNetworkErrorMessage = (): string => {
  if (typeof window === "undefined") {
    return "Falha de rede ao conectar com a API.";
  }

  const { hostname, protocol } = window.location;

  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return protocol === "https:"
      ? "Falha de rede ao conectar com a API. Em ambiente local, prefira http://127.0.0.1/login."
      : "Falha de rede ao conectar com a API local. Verifique se a stack Docker da InfraCode esta ativa.";
  }

  return "Falha de rede ao conectar com a API.";
};

const parseErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { message?: string; code?: string };
    return payload.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
};

const parseErrorCode = async (response: Response): Promise<string | undefined> => {
  try {
    const payload = (await response.json()) as { code?: string };
    return payload.code;
  } catch {
    return undefined;
  }
};

const baseInputClassName =
  "h-12 w-full rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-4 text-sm text-white outline-none transition-colors placeholder:text-[#444444] focus:border-[#60a5fa] focus:ring-2 focus:ring-[#60a5fa]/20";

export const LoginForm = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showSecondFactor, setShowSecondFactor] = useState(false);

  const submit = async () => {
    const apiBaseUrl = getClientPanelConfig().apiBaseUrl;

    setError(null);
    setPending(true);

    try {
      const response = await fetch(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email,
          password,
          ...(totpCode.trim() ? { totpCode: totpCode.trim() } : {}),
          ...(backupCode.trim() ? { backupCode: backupCode.trim() } : {})
        })
      });

      if (!response.ok) {
        // Clone response before reading it twice
        const cloned = response.clone();
        const errorCode = await parseErrorCode(cloned);

        if (errorCode === "SECOND_FACTOR_REQUIRED") {
          setShowSecondFactor(true);
          setError("Informe o codigo TOTP ou backup code para continuar.");
          return;
        }

        throw new Error(await parseErrorMessage(response));
      }

      const tokens = (await response.json()) as AuthTokensResponse;
      clearBrowserSession();
      persistBrowserSession({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tenantSlug: tokens.tenantSlug ?? undefined
      });

      window.location.assign(tokens.redirectTo);
    } catch (caught) {
      if (caught instanceof TypeError) {
        setError(getNetworkErrorMessage());
        return;
      }

      setError(caught instanceof Error ? caught.message : "Falha ao autenticar");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="rounded-[20px] border border-[#1e1e1e] bg-[#0f0f0f] p-10 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
      <form
        className="space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
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
              autoComplete="current-password"
              className={baseInputClassName}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Sua chave de acesso"
              type="password"
              value={password}
            />
          </label>

          {showSecondFactor ? (
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
            disabled={pending}
            type="submit"
          >
            {pending ? "Autenticando..." : "Entrar"}
          </Button>
        </div>
      </form>

      <div className="mt-8 flex items-center justify-between gap-4 border-t border-white/6 pt-6">
        <Link
          className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#93c5fd] transition-colors hover:text-[#bfdbfe]"
          href="/redefinir-senha"
        >
          Esqueceu seu acesso?
        </Link>
        <div className="text-[11px] font-medium uppercase tracking-[0.24em] text-white/18">v2.5.0</div>
      </div>
    </div>
  );
};
