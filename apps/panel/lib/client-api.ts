import { getClientPanelConfig } from "./client-panel-config";
import { clearBrowserSession, getBrowserSession, persistBrowserSession } from "./session";

interface ClientApiRequestOptions {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
}

const parseErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { message?: string };
    return payload.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
};

const redirectToLogin = (): never => {
  clearBrowserSession();

  if (typeof window !== "undefined") {
    window.location.assign("/login");
  }

  throw new Error("Sua sessao expirou. Faca login novamente.");
};

const tryRefreshSession = async (): Promise<boolean> => {
  const panelConfig = getClientPanelConfig();
  const session = getBrowserSession();

  if (!session.refreshToken) {
    return false;
  }

  const response = await fetch(`${panelConfig.apiBaseUrl}/auth/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      refreshToken: session.refreshToken
    })
  });

  if (!response.ok) {
    return false;
  }

  const payload = (await response.json()) as { accessToken: string; refreshToken: string };
  persistBrowserSession({
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    tenantSlug: session.tenantSlug,
    apiKey: session.apiKey
  });

  return true;
};

/**
 * Executa chamadas autenticadas do painel para a API publica da plataforma.
 */
export const requestClientApi = async <TResponse>(
  path: string,
  options: ClientApiRequestOptions = {},
  hasRetried = false
): Promise<TResponse> => {
  const panelConfig = getClientPanelConfig();
  const session = getBrowserSession();
  const hasBody = options.body !== undefined;
  const response = await fetch(`${panelConfig.apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(session.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {}),
      ...(!session.accessToken && session.apiKey ? { "x-api-key": session.apiKey } : {}),
      ...(options.headers ?? {})
    },
    body: hasBody ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    if (response.status === 401 && !hasRetried) {
      const refreshed = await tryRefreshSession();

      if (refreshed) {
        return requestClientApi<TResponse>(path, options, true);
      }

      return redirectToLogin();
    }

    if (response.status === 401) {
      return redirectToLogin();
    }

    throw new Error(await parseErrorMessage(response));
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  return (await response.json()) as TResponse;
};
