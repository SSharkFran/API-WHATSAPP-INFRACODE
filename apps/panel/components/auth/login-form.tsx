"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Input } from "@infracode/ui";
import { clearBrowserSession, persistBrowserSession, resolveTenantSlugFromBrowserHost } from "../../lib/session";
import { getClientPanelConfig } from "../../lib/client-panel-config";

type LoginMode = "admin" | "tenant";

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

export const LoginForm = () => {
  const [email, setEmail] = useState("owner@infracode.local");
  const [password, setPassword] = useState("ChangeMe123!");
  const [tenantSlug, setTenantSlug] = useState(() => getClientPanelConfig().tenantSlug);
  const [totpCode, setTotpCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<LoginMode | null>(null);

  useEffect(() => {
    const slugFromHost = resolveTenantSlugFromBrowserHost();

    if (slugFromHost) {
      setTenantSlug(slugFromHost);
    }
  }, []);

  const submit = async (mode: LoginMode) => {
    const apiBaseUrl = getClientPanelConfig().apiBaseUrl;
    const resolvedTenantSlug = tenantSlug.trim() || resolveTenantSlugFromBrowserHost();

    if (mode === "tenant" && !resolvedTenantSlug) {
      setError("Informe o slug do tenant para acessar o painel do cliente.");
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
          ...(totpCode.trim() ? { totpCode: totpCode.trim() } : {}),
          ...(backupCode.trim() ? { backupCode: backupCode.trim() } : {})
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
    <div className="space-y-5">
      <div className="grid gap-4">
        <label className="block text-sm font-medium text-slate-200">
          Email
          <Input
            className="mt-2 h-12 rounded-2xl border-white/10 bg-slate-950/55 px-4 text-slate-50 placeholder:text-slate-500 focus:border-sky-400"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="owner@infracode.local"
            value={email}
          />
        </label>
        <label className="block text-sm font-medium text-slate-200">
          Senha
          <Input
            className="mt-2 h-12 rounded-2xl border-white/10 bg-slate-950/55 px-4 text-slate-50 placeholder:text-slate-500 focus:border-sky-400"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="********"
            type="password"
            value={password}
          />
        </label>
        <label className="block text-sm font-medium text-slate-200">
          Slug do tenant
          <Input
            className="mt-2 h-12 rounded-2xl border-white/10 bg-slate-950/55 px-4 text-slate-50 placeholder:text-slate-500 focus:border-sky-400"
            onChange={(event) => setTenantSlug(event.target.value)}
            placeholder="demo"
            value={tenantSlug}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-200">
            TOTP
            <Input
              className="mt-2 h-12 rounded-2xl border-white/10 bg-slate-950/55 px-4 text-slate-50 placeholder:text-slate-500 focus:border-sky-400"
              onChange={(event) => setTotpCode(event.target.value)}
              placeholder="123456"
              value={totpCode}
            />
          </label>
          <label className="block text-sm font-medium text-slate-200">
            Backup code
            <Input
              className="mt-2 h-12 rounded-2xl border-white/10 bg-slate-950/55 px-4 text-slate-50 placeholder:text-slate-500 focus:border-sky-400"
              onChange={(event) => setBackupCode(event.target.value)}
              placeholder="backup-code"
              value={backupCode}
            />
          </label>
        </div>
      </div>

      {error ? (
        <p className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          className="h-12 w-full rounded-2xl bg-sky-500 text-base font-semibold text-slate-950 hover:bg-sky-400"
          disabled={pendingMode !== null}
          onClick={() => void submit("admin")}
        >
          {pendingMode === "admin" ? "Entrando..." : "Painel Super Admin"}
        </Button>
        <Button
          className="h-12 w-full rounded-2xl border border-white/12 bg-white/6 text-base font-semibold text-slate-50 hover:bg-white/12"
          disabled={pendingMode !== null}
          onClick={() => void submit("tenant")}
          variant="secondary"
        >
          {pendingMode === "tenant" ? "Entrando..." : "Painel do Cliente"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400">
        <span>Em localhost ou 127.0.0.1, informe o slug do tenant manualmente. Em subdominio ele e resolvido automaticamente.</span>
        <Link className="text-sky-300 underline underline-offset-4 transition hover:text-sky-200" href="/redefinir-senha">
          Redefinir senha
        </Link>
      </div>
    </div>
  );
};
