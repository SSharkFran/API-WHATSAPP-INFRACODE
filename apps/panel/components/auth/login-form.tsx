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
    <div className="space-y-8">
      <div className="space-y-8">
        <label className="group block space-y-1">
          <span className="label-mini-caps">Email</span>
          <Input
            className="input-underline"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Endereço de e-mail registrado"
            value={email}
          />
        </label>
        <label className="group block space-y-1">
          <span className="label-mini-caps">Senha</span>
          <Input
            className="input-underline"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Sua chave de acesso"
            type="password"
            value={password}
          />
        </label>
        <label className="group block space-y-1">
          <span className="label-mini-caps">Slug do tenant</span>
          <Input
            className="input-underline"
            onChange={(event) => setTenantSlug(event.target.value)}
            placeholder="Ex: demo (opcional em subdomínio)"
            value={tenantSlug}
          />
        </label>
        
        <div className="grid grid-cols-1 gap-8 xs:grid-cols-2">
          <label className="group block space-y-1">
            <span className="label-mini-caps">TOTP (2FA)</span>
            <Input
              className="input-underline"
              onChange={(event) => setTotpCode(event.target.value)}
              placeholder="000 000"
              value={totpCode}
            />
          </label>
          <label className="group block space-y-1">
            <span className="label-mini-caps">Backup</span>
            <Input
              className="input-underline"
              onChange={(event) => setBackupCode(event.target.value)}
              placeholder="Code"
              value={backupCode}
            />
          </label>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-rose-500/60 font-medium">
          <span className="w-1 h-1 rounded-full bg-rose-500" />
          {error}
        </div>
      ) : null}

      <div className="flex flex-col items-center">
        <Button
          className="btn-blue-flat"
          disabled={pendingMode !== null}
          onClick={() => void submit("admin")}
        >
          {pendingMode === "admin" ? "Autenticando..." : "Acessar Super Admin"}
        </Button>
        
        <button
          className="btn-ghost-small hover:text-white/40 transition-colors"
          disabled={pendingMode !== null}
          onClick={() => void submit("tenant")}
        >
          {pendingMode === "tenant" ? "Aguarde..." : "Acessar Painel do Cliente"}
        </button>
      </div>

      <div className="pt-8 flex flex-col items-center gap-6">
        <Link className="text-[10px] uppercase tracking-[0.1em] text-white/20 hover:text-white/40 transition-colors" href="/redefinir-senha">
          Esqueceu seu acesso?
        </Link>
        <div className="text-[10px] text-white/10 font-medium tracking-widest">
           v2.4.1 · InfraCode
        </div>
      </div>
    </div>
  );
};
