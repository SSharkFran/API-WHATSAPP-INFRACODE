import { getClientPanelConfig } from "./client-panel-config";
import { getBrowserSession } from "./session";

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

/**
 * Executa chamadas autenticadas do painel para a API publica da plataforma.
 */
export const requestClientApi = async <TResponse>(
  path: string,
  options: ClientApiRequestOptions = {}
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
    throw new Error(await parseErrorMessage(response));
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  return (await response.json()) as TResponse;
};
