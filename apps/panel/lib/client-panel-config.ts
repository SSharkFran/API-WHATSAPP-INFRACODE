import { getBrowserSession } from "./session";

const publicApiBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
const defaultTenantSlug = process.env.NEXT_PUBLIC_DEFAULT_TENANT ?? "demo";

const inferBrowserApiBaseUrl = (): string | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }

  const { hostname, origin, protocol } = window.location;

  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return `${origin}/api`;
  }

  const parts = hostname.split(".");

  if (parts.length >= 3) {
    return `${protocol}//api.${parts.slice(1).join(".")}`;
  }

  return undefined;
};

const resolveBrowserApiBaseUrl = (): string => {
  const inferredApiBaseUrl = inferBrowserApiBaseUrl();

  if (inferredApiBaseUrl) {
    return inferredApiBaseUrl;
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
