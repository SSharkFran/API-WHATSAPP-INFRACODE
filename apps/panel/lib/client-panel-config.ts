import { getBrowserSession } from "./session";

const publicApiBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

const resolveConfiguredApiBaseUrl = (): string | undefined => {
  if (!publicApiBaseUrl) {
    return undefined;
  }

  if (publicApiBaseUrl.startsWith("/")) {
    if (typeof window === "undefined") {
      return publicApiBaseUrl;
    }

    return `${window.location.origin}${publicApiBaseUrl}`;
  }

  return publicApiBaseUrl;
};

const resolveBrowserApiBaseUrl = (): string => {
  const configuredApiBaseUrl = resolveConfiguredApiBaseUrl();

  if (configuredApiBaseUrl) {
    return configuredApiBaseUrl;
  }

  // Sempre usar /api no mesmo dominio — o Next.js faz proxy para a API interna
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api`;
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
