import "server-only";
import { cookies } from "next/headers";
import { PANEL_COOKIE_NAMES, type PanelSession } from "./session";

/**
 * Le os cookies de sessao do painel dentro do ambiente SSR do Next.js.
 */
export const getServerPanelSession = (): PanelSession => {
  const store = cookies();

  return {
    accessToken: store.get(PANEL_COOKIE_NAMES.accessToken)?.value,
    apiKey: store.get(PANEL_COOKIE_NAMES.apiKey)?.value,
    refreshToken: store.get(PANEL_COOKIE_NAMES.refreshToken)?.value,
    tenantSlug: store.get(PANEL_COOKIE_NAMES.tenantSlug)?.value
  };
};
