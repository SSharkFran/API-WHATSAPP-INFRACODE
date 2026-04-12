import { getBrowserSession } from "./session";

const publicApiBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

/**
 * Resolve a URL base da API.
 *
 * Prioridade:
 * 1. NEXT_PUBLIC_API_BASE_URL (variavel de ambiente)
 * 2. Fallback para http://localhost:3333 (desenvolvimento local)
 */
const resolveBrowserApiBaseUrl = (): string => {
  if (publicApiBaseUrl) {
    if (publicApiBaseUrl.startsWith("/") && typeof window !== "undefined") {
      return `${window.location.origin}${publicApiBaseUrl}`;
    }
    return publicApiBaseUrl;
  }

  return "http://localhost:3333";
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
