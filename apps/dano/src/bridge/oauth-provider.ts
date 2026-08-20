import { AsyncLocalStorage } from "node:async_hooks";
import * as oauth from "openid-client";

export interface ExternalIdentity {
  readonly userId: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export class OAuthProviderContractError extends Error {
  readonly code = "provider_identity_invalid" as const;

  constructor() {
    super("Provider identity response does not match the configured contract");
    this.name = "OAuthProviderContractError";
  }
}

export interface ProviderCredential {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType?: string;
  readonly expiresAt?: number;
}

export interface OAuthProviderAdapter {
  authorizationUrl(input: {
    readonly state: string;
    readonly redirectUri: string;
  }): URL;
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly state: string;
    readonly redirectUri: string;
  }): Promise<{
    readonly identity: ExternalIdentity;
    readonly credential: ProviderCredential;
  }>;
  refreshCredential?(
    credential: ProviderCredential,
  ): Promise<ProviderCredential>;
  validateCredential?(
    credential: ProviderCredential,
  ): Promise<ExternalIdentity>;
  isAccessTokenInvalid?(response: Response): boolean | Promise<boolean>;
  revokeCredential?(credential: ProviderCredential): Promise<void>;
}

export interface OAuth2ProviderAdapterOptions {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly identityEndpoint: string;
  readonly revocation?:
    | { readonly transport: "rfc7009"; readonly endpoint: string }
    | { readonly transport: "delete-query-basic"; readonly endpoint?: string };
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clientAuthMethod?:
    | "client_secret_post"
    | "client_secret_basic"
    | "client_secret_basic_raw";
  readonly scope: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly sendStateToTokenEndpoint?: boolean;
  readonly timeoutMs?: number;
  /** Explicit deployment opt-in for a browser-facing HTTP authorization URL. */
  readonly allowInsecureAuthorizationEndpoint?: boolean;
  /** Explicit deployment opt-in for plaintext HTTP provider endpoints. */
  readonly allowInsecureProviderEndpoints?: boolean;
  /** Test-only escape hatch for a loopback fake provider. */
  readonly allowInsecureRequests?: boolean;
}

export function createOAuth2ProviderAdapter(
  options: OAuth2ProviderAdapterOptions,
): OAuthProviderAdapter {
  const tokenEndpoint = new URL(options.tokenEndpoint);
  const revocationEndpoint = options.revocation
    ? new URL(options.revocation.endpoint ?? tokenEndpoint)
    : undefined;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const tokenExchangeState = new AsyncLocalStorage<string>();
  const clientId = required(options.clientId, "OAuth client ID");
  const clientSecret = required(options.clientSecret, "OAuth client secret");
  const clientAuthentication = clientAuthenticationFor(
    options.clientAuthMethod,
    clientSecret,
  );
  const serverMetadata = {
    issuer: new URL(options.issuer).href,
    authorization_endpoint: new URL(options.authorizationEndpoint).href,
    token_endpoint: tokenEndpoint.href,
    ...(options.revocation?.transport === "rfc7009" && revocationEndpoint
      ? { revocation_endpoint: revocationEndpoint.href }
      : {}),
  };
  const configuration = new oauth.Configuration(
    serverMetadata,
    clientId,
    { client_secret: clientSecret },
    clientAuthentication,
  );
  configuration.timeout = timeoutMs / 1000;
  if (
    options.allowInsecureAuthorizationEndpoint ||
    options.allowInsecureProviderEndpoints ||
    options.allowInsecureRequests
  ) {
    oauth.allowInsecureRequests(configuration);
  }
  const requestHeaders = new Headers(options.requestHeaders);
  configuration[oauth.customFetch] = async (url, init) => {
    const headers = new Headers(requestHeaders);
    for (const [name, value] of Object.entries(init.headers)) {
      headers.set(name, value);
    }
    const response = await fetch(url, {
      ...init,
      headers,
      body:
        options.sendStateToTokenEndpoint &&
        new URL(url).href === tokenEndpoint.href
          ? tokenBodyWithState(init.body, tokenExchangeState.getStore())
          : init.body,
    });
    if (new URL(url).href !== tokenEndpoint.href) return response;
    return normalizeTokenEndpointResponse(response);
  };
  const identityEndpoint = new URL(options.identityEndpoint);
  const scope = required(options.scope, "OAuth scope");

  const adapter: OAuthProviderAdapter = {
    authorizationUrl({ state, redirectUri }) {
      return oauth.buildAuthorizationUrl(configuration, {
        redirect_uri: redirectUri,
        scope,
        state,
      });
    },

    async exchangeAuthorizationCode({ code, state, redirectUri }) {
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);
      const tokens = await tokenExchangeState.run(state, () =>
        oauth.authorizationCodeGrant(
          configuration,
          callbackUrl,
          { expectedState: state },
        ),
      );
      const identity = await fetchExternalIdentity(
        configuration,
        tokens.access_token,
        tokens.token_type,
        identityEndpoint,
      );
      const expiresIn = tokens.expiresIn();
      return {
        identity,
        credential: tokenResponseCredential(tokens, expiresIn),
      };
    },

    async refreshCredential(credential) {
      if (!credential.refreshToken) {
        throw new Error("Provider refresh credential is unavailable");
      }
      const tokens = await oauth.refreshTokenGrant(
        configuration,
        credential.refreshToken,
      );
      const expiresIn = tokens.expiresIn();
      const refreshed = tokenResponseCredential(
        tokens,
        expiresIn,
        credential.refreshToken,
      );
      return refreshed;
    },

    async validateCredential(credential) {
      return fetchExternalIdentity(
        configuration,
        credential.accessToken,
        credential.tokenType,
        identityEndpoint,
      );
    },

    async isAccessTokenInvalid(response) {
      if (response.status === 401) return true;
      let value: unknown;
      try {
        value = await response.clone().json();
      } catch {
        return false;
      }
      return providerAuthenticationInvalid(value);
    },

  };
  let revokeCredential:
    | ((credential: ProviderCredential) => Promise<void>)
    | undefined;
  if (options.revocation?.transport === "rfc7009") {
    revokeCredential = async credential => {
      await oauth.tokenRevocation(configuration, credential.accessToken);
    };
  } else if (
    options.revocation?.transport === "delete-query-basic" &&
    revocationEndpoint
  ) {
    revokeCredential = async credential => {
      await deleteQueryRevocation({
        endpoint: revocationEndpoint,
        accessToken: credential.accessToken,
        clientId,
        clientSecret,
        requestHeaders,
        timeoutMs,
      });
    };
  }
  return {
    ...adapter,
    ...(revokeCredential ? { revokeCredential } : {}),
  };
}

function clientAuthenticationFor(
  method: OAuth2ProviderAdapterOptions["clientAuthMethod"],
  clientSecret: string,
): oauth.ClientAuth {
  if (method === "client_secret_basic") {
    return oauth.ClientSecretBasic(clientSecret);
  }
  if (method === "client_secret_basic_raw") {
    return (_server, client, _body, headers) => {
      if (client.client_id.includes(":")) {
        throw new Error("OAuth raw Basic client ID must not contain a colon");
      }
      headers.set(
        "authorization",
        `Basic ${Buffer.from(`${client.client_id}:${clientSecret}`).toString("base64")}`,
      );
    };
  }
  return oauth.ClientSecretPost(clientSecret);
}

async function fetchExternalIdentity(
  configuration: oauth.Configuration,
  accessToken: string,
  tokenType: string | undefined,
  identityEndpoint: URL,
): Promise<ExternalIdentity> {
  if (tokenType && tokenType.trim().toLowerCase() !== "bearer") {
    throw new Error("Provider access token type is unsupported");
  }
  const response = await oauth.fetchProtectedResource(
    configuration,
    accessToken,
    identityEndpoint,
    "GET",
  );
  if (!response.ok) {
    throw new Error("Provider identity request failed");
  }
  return parseExternalIdentity(await response.json());
}

async function deleteQueryRevocation(input: {
  readonly endpoint: URL;
  readonly accessToken: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly requestHeaders: Headers;
  readonly timeoutMs: number;
}): Promise<void> {
  const url = new URL(input.endpoint);
  url.searchParams.set("token", input.accessToken);
  const headers = new Headers(input.requestHeaders);
  headers.set(
    "authorization",
    `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
  );
  const response = await fetch(url, {
    method: "DELETE",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) throw new Error("Provider credential revocation failed");
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return;
  }
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    "code" in result &&
    (result as Record<string, unknown>).code !== 0
  ) {
    throw new Error("Provider credential revocation failed");
  }
}

function tokenResponseCredential(
  tokens: {
    readonly access_token: string;
    readonly refresh_token?: string;
    readonly token_type?: string;
  },
  expiresIn: number | undefined,
  fallbackRefreshToken?: string,
): ProviderCredential {
  const refreshToken = tokens.refresh_token ?? fallbackRefreshToken;
  return {
    accessToken: tokens.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(tokens.token_type ? { tokenType: tokens.token_type } : {}),
    ...(expiresIn !== undefined
      ? { expiresAt: Date.now() + expiresIn * 1000 }
      : {}),
  };
}

function parseExternalIdentity(value: unknown): ExternalIdentity {
  const identity = providerDataObject(value);
  if (!identity) {
    throw new OAuthProviderContractError();
  }
  const userId = normalizedIdentifier(identity.userId ?? identity.id);
  if (!userId) {
    throw new OAuthProviderContractError();
  }
  const displayName = normalizedString(
    identity.displayName ?? identity.nickname ?? identity.name ?? identity.username,
  );
  const avatarUrl = normalizedString(identity.avatarUrl ?? identity.avatar);
  return {
    userId,
    ...(displayName ? { displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

async function normalizeTokenEndpointResponse(
  response: Response,
): Promise<Response> {
  let value: unknown;
  try {
    value = await response.clone().json();
  } catch {
    return response;
  }
  const data = providerDataObject(value);
  if (!data || typeof data.access_token !== "string") return response;

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const normalized = new Response(JSON.stringify(data), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  Object.defineProperty(normalized, "url", { value: response.url });
  return normalized;
}

function providerDataObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !("userId" in record) &&
    !("id" in record) &&
    record.data &&
    typeof record.data === "object" &&
    !Array.isArray(record.data)
  ) {
    return record.data as Record<string, unknown>;
  }
  return record;
}

function providerAuthenticationInvalid(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const code = (value as Record<string, unknown>).code;
  return code === 401 || (typeof code === "string" && code.trim() === "401");
}

function normalizedIdentifier(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return null;
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tokenBodyWithState(
  body: oauth.FetchBody,
  state: string | undefined,
): oauth.FetchBody {
  if (!state) return body;
  const params =
    body instanceof URLSearchParams
      ? new URLSearchParams(body)
      : typeof body === "string"
        ? new URLSearchParams(body)
        : null;
  if (!params || params.get("grant_type") !== "authorization_code") {
    return body;
  }
  params.set("state", state);
  return params;
}

function required(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
