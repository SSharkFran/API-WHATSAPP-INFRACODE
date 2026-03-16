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
      <div className="grid gap-6">
        <label className="group block space-y-2">
          <span className="label-minimal transition-colors group-hover:text-white/40">Email</span>
          <Input
            className="input-minimal px-0 text-[13px] placeholder:text-[#2e3d58] border-t-0 border-x-0 border-b-[0.5px] hover:border-b-white/20 focus:border-b-white/40 transition-all"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="email@address.com"
            value={email}
          />
        </label>
        <label className="group block space-y-2">
          <span className="label-minimal transition-colors group-hover:text-white/40">Senha</span>
          <Input
            className="input-minimal px-0 text-[13px] placeholder:text-[#2e3d58] border-t-0 border-x-0 border-b-[0.5px] hover:border-b-white/20 focus:border-b-white/40 transition-all"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            type="password"
            value={password}
          />
        </label>
        <label className="group block space-y-2">
          <span className="label-minimal transition-colors group-hover:text-white/40">Slug do tenant</span>
          <Input
            className="input-minimal px-0 text-[13px] placeholder:text-[#2e3d58] border-t-0 border-x-0 border-b-[0.5px] hover:border-b-white/20 focus:border-b-white/40 transition-all"
            onChange={(event) => setTenantSlug(event.target.value)}
            placeholder="slug-exemplo"
            value={tenantSlug}
          />
        </label>
        
        <div className="grid grid-cols-1 gap-6 xs:grid-cols-2">
          <label className="group block space-y-2">
            <span className="label-minimal transition-colors group-hover:text-white/40">TOTP</span>
            <Input
              className="input-minimal px-0 text-[13px] placeholder:text-[#2e3d58] border-t-0 border-x-0 border-b-[0.5px] hover:border-b-white/20 focus:border-b-white/40 transition-all"
              onChange={(event) => setTotpCode(event.target.value)}
              placeholder="000000"
              value={totpCode}
            />
          </label>
          <label className="group block space-y-2">
            <span className="label-minimal transition-colors group-hover:text-white/40">Backup</span>
            <Input
              className="input-minimal px-0 text-[13px] placeholder:text-[#2e3d58] border-t-0 border-x-0 border-b-[0.5px] hover:border-b-white/20 focus:border-b-white/40 transition-all"
              onChange={(event) => setBackupCode(event.target.value)}
              placeholder="code-123"
              value={backupCode}
            />
          </label>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-rose-500/80">
          <span>×</span>
          {error}
        </div>
      ) : null}

      <div className="grid gap-3">
        <Button
          className="btn-primary-minimal h-12 text-[13px] tracking-tight transition-opacity hover:opacity-90"
          disabled={pendingMode !== null}
          onClick={() => void submit("admin")}
        >
          {pendingMode === "admin" ? "Aguarde..." : "Acessar Super Admin"}
        </Button>
        <Button
          className="btn-secondary-minimal h-12 text-[13px] tracking-tight transition-colors hover:text-white/60 hover:border-white/20"
          disabled={pendingMode !== null}
          onClick={() => void submit("tenant")}
          variant="secondary"
        >
          {pendingMode === "tenant" ? "Aguarde..." : "Painel do Cliente"}
        </Button>
      </div>

      <div className="space-y-4 pt-4 text-[10px] uppercase tracking-[0.1em] text-[#2e3d58]">
        <p className="leading-loose">Identificação automática via DNS ativa em produção.</p>
        <Link className="block text-white/20 hover:text-white/60 transition-colors" href="/redefinir-senha">
          Solicitar nova senha
        </Link>
      </div>
    </div>
  );
};
