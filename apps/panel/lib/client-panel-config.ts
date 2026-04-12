import { getBrowserSession } from "./session";

const publicApiBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

/**
 * Resolve a URL base da API.
 *
 * Prioridade:
 * 1. NEXT_PUBLIC_API_BASE_URL (variavel de ambiente, injetada no build)
 * 2. Em producao: inferir api.{rootDomain} do hostname atual (runtime)
 * 3. Em localhost: http://localhost:3333
 */
const resolveBrowserApiBaseUrl = (): string => {
  // 1. Variavel de ambiente definida
  if (publicApiBaseUrl) {
    if (publicApiBaseUrl.startsWith("/") && typeof window !== "undefined") {
      return `${window.location.origin}${publicApiBaseUrl}`;
    }
    return publicApiBaseUrl;
  }

  // SSR: fallback local
  if (typeof window === "undefined") {
    return "http://localhost:3333";
  }

  const { hostname, protocol } = window.location;

  // 3. Localhost: API local
  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return "http://localhost:3333";
  }

  // 2. Producao: inferir api.{rootDomain}
  //    wa.infracode.pro -> api.wa.infracode.pro
  const parts = hostname.split(".");
  if (parts.length >= 3) {
    // Remove o primeiro subdominio (ex: "zelo" ou "admin") e prefixa com "api"
    return `${protocol}//api.${parts.slice(1).join(".")}`;
  }

  // Fallback: api.{domain} ex: infracode.pro -> api.infracode.pro
  return `${protocol}//api.${hostname}`;
};

/**
 * Resolve a configuracao publica consumida pelos componentes client-side do painel.
 */
export const getClientPanelConfig = () => {
  const session = getBrowserSession();

  return {
    apiBaseUrl: resolveBrowserApiBaseUrl(),
    tenantAccessToken: session.accessToken ?? "",
    tenantApiKey: session.apiKey ?? "",
    tenantSlug: session.tenantSlug ?? ""
  };
};
