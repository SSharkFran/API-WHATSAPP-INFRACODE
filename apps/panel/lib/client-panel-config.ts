import { getBrowserSession } from "./session";

const publicApiBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
const defaultTenantSlug = process.env.NEXT_PUBLIC_DEFAULT_TENANT ?? "demo";

const resolveBrowserApiBaseUrl = (): string => {
  if (!publicApiBaseUrl && typeof window !== "undefined") {
    return `${window.location.origin}/api`;
  }

  if (publicApiBaseUrl.startsWith("/") && typeof window !== "undefined") {
    return `${window.location.origin}${publicApiBaseUrl}`;
  }

  return publicApiBaseUrl || "http://localhost:3333";
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
    tenantSlug: session.tenantSlug ?? defaultTenantSlug
  };
};
