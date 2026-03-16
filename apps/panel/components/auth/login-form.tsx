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
    <div className="space-y-6">
      <div className="grid gap-5">
        <label className="block text-[13px] font-medium tracking-wide text-slate-400">
          Email
          <Input
            className="mt-2 h-[52px] rounded-[10px] border-white/5 bg-slate-950/20 px-4 text-slate-50 placeholder:text-slate-600 focus:border-sky-500/50 transition-all"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="owner@infracode.local"
            value={email}
          />
        </label>
        <label className="block text-[13px] font-medium tracking-wide text-slate-400">
          Senha
          <Input
            className="mt-2 h-[52px] rounded-[10px] border-white/5 bg-slate-950/20 px-4 text-slate-50 placeholder:text-slate-600 focus:border-sky-500/50 transition-all"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="********"
            type="password"
            value={password}
          />
        </label>
        <label className="block text-[13px] font-medium tracking-wide text-slate-400">
          Slug do tenant
          <Input
            className="mt-2 h-[52px] rounded-[10px] border-white/5 bg-slate-950/20 px-4 text-slate-50 placeholder:text-slate-600 focus:border-sky-500/50 transition-all"
            onChange={(event) => setTenantSlug(event.target.value)}
            placeholder="demo"
            value={tenantSlug}
          />
        </label>
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block text-[13px] font-medium tracking-wide text-slate-400">
            TOTP
            <Input
              className="mt-2 h-[52px] rounded-[10px] border-white/5 bg-slate-950/20 px-4 text-slate-50 placeholder:text-slate-600 focus:border-sky-500/50 transition-all"
              onChange={(event) => setTotpCode(event.target.value)}
              placeholder="123456"
              value={totpCode}
            />
          </label>
          <label className="block text-[13px] font-medium tracking-wide text-slate-400">
            Backup code
            <Input
              className="mt-2 h-[52px] rounded-[10px] border-white/5 bg-slate-950/20 px-4 text-slate-50 placeholder:text-slate-600 focus:border-sky-500/50 transition-all"
              onChange={(event) => setBackupCode(event.target.value)}
              placeholder="backup-code"
              value={backupCode}
            />
          </label>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-3 rounded-[10px] border border-rose-500/10 bg-rose-500/5 px-4 py-3 text-[13px] text-rose-300 animate-in fade-in slide-in-from-top-1">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]" />
          {error}
        </div>
      ) : null}

      <div className="grid gap-4">
        <Button
          className="h-[52px] w-full rounded-[10px] bg-sky-500 text-[15px] font-bold text-slate-950 hover:bg-sky-400 transition-all shadow-[0_10px_20px_rgba(14,165,233,0.15)] hover:shadow-[0_10px_25px_rgba(14,165,233,0.25)]"
          disabled={pendingMode !== null}
          onClick={() => void submit("admin")}
        >
          {pendingMode === "admin" ? "Entrando..." : "Painel Super Admin"}
        </Button>
        <Button
          className="h-[52px] w-full rounded-[10px] border border-white/10 bg-white/5 text-[15px] font-bold text-slate-100 hover:bg-white/10 transition-all"
          disabled={pendingMode !== null}
          onClick={() => void submit("tenant")}
          variant="secondary"
        >
          {pendingMode === "tenant" ? "Entrando..." : "Painel do Cliente"}
        </Button>
      </div>

      <div className="flex flex-col gap-4 pt-2 text-[12px] text-slate-500 leading-relaxed">
        <p>Em localhost ou 127.0.0.1, informe o slug do tenant manualmente. Em subdomínio ele é resolvido automaticamente.</p>
        <Link className="text-sky-400/80 hover:text-sky-300 transition-colors w-fit underline underline-offset-4" href="/redefinir-senha">
          Esqueceu sua senha?
        </Link>
      </div>
    </div>
  );
};
