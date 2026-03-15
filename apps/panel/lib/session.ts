export interface PanelSession {
  accessToken?: string;
  apiKey?: string;
  refreshToken?: string;
  tenantSlug?: string;
}

export const PANEL_COOKIE_NAMES = {
  accessToken: "ic_access_token",
  apiKey: "ic_api_key",
  refreshToken: "ic_refresh_token",
  tenantSlug: "ic_tenant_slug"
} as const;

const readCookie = (cookieSource: string, name: string): string | undefined => {
  const prefix = `${name}=`;

  for (const chunk of cookieSource.split(";")) {
    const normalized = chunk.trim();

    if (!normalized.startsWith(prefix)) {
      continue;
    }

    return decodeURIComponent(normalized.slice(prefix.length));
  }

  return undefined;
};

/**
 * Le a sessao persistida em cookies acessiveis pelo navegador.
 */
export const getBrowserSession = (): PanelSession => {
  if (typeof document === "undefined") {
    return {};
  }

  const cookieSource = document.cookie;

  return {
    accessToken: readCookie(cookieSource, PANEL_COOKIE_NAMES.accessToken),
    apiKey: readCookie(cookieSource, PANEL_COOKIE_NAMES.apiKey),
    refreshToken: readCookie(cookieSource, PANEL_COOKIE_NAMES.refreshToken),
    tenantSlug: readCookie(cookieSource, PANEL_COOKIE_NAMES.tenantSlug)
  };
};

const persistCookie = (name: string, value: string, maxAgeSeconds: number): void => {
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax`;
};

/**
 * Persiste a sessao do painel em cookies leves para uso do SSR e do cliente.
 */
export const persistBrowserSession = (session: PanelSession): void => {
  if (typeof document === "undefined") {
    return;
  }

  if (session.accessToken) {
    persistCookie(PANEL_COOKIE_NAMES.accessToken, session.accessToken, 60 * 60 * 8);
  }

  if (session.refreshToken) {
    persistCookie(PANEL_COOKIE_NAMES.refreshToken, session.refreshToken, 60 * 60 * 24 * 14);
  }

  if (session.apiKey) {
    persistCookie(PANEL_COOKIE_NAMES.apiKey, session.apiKey, 60 * 60 * 24 * 30);
  }

  if (session.tenantSlug) {
    persistCookie(PANEL_COOKIE_NAMES.tenantSlug, session.tenantSlug, 60 * 60 * 24 * 30);
  }
};

/**
 * Limpa a sessao persistida do painel.
 */
export const clearBrowserSession = (): void => {
  if (typeof document === "undefined") {
    return;
  }

  for (const name of Object.values(PANEL_COOKIE_NAMES)) {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  }
};

/**
 * Resolve o slug do tenant a partir do hostname do navegador quando o painel roda por subdominio.
 */
export const resolveTenantSlugFromBrowserHost = (): string | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }

  const hostname = window.location.hostname.toLowerCase();

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return undefined;
  }

  const parts = hostname.split(".");

  if (parts.length < 3 || parts[0] === "admin") {
    return undefined;
  }

  return parts[0];
};
