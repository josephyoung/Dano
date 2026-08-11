import * as oauth from "openid-client";

export interface ExternalIdentity {
  readonly userId: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
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
  isAccessTokenInvalid?(response: Response): boolean;
  revokeCredential?(credential: ProviderCredential): Promise<void>;
}

export interface OAuth2ProviderAdapterOptions {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly identityEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope: string;
  readonly timeoutMs?: number;
  /** Test-only escape hatch for a loopback fake provider. */
  readonly allowInsecureRequests?: boolean;
}

export function createOAuth2ProviderAdapter(
  options: OAuth2ProviderAdapterOptions,
): OAuthProviderAdapter {
  const configuration = new oauth.Configuration(
    {
      issuer: new URL(options.issuer).href,
      authorization_endpoint: new URL(options.authorizationEndpoint).href,
      token_endpoint: new URL(options.tokenEndpoint).href,
    },
    required(options.clientId, "OAuth client ID"),
    { client_secret: required(options.clientSecret, "OAuth client secret") },
    oauth.ClientSecretPost(options.clientSecret),
  );
  configuration.timeout = (options.timeoutMs ?? 10_000) / 1000;
  if (options.allowInsecureRequests) oauth.allowInsecureRequests(configuration);
  const identityEndpoint = new URL(options.identityEndpoint);
  const scope = required(options.scope, "OAuth scope");

  return {
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
      const tokens = await oauth.authorizationCodeGrant(
        configuration,
        callbackUrl,
        { expectedState: state },
      );
      const identityResponse = await oauth.fetchProtectedResource(
        configuration,
        tokens.access_token,
        identityEndpoint,
        "GET",
      );
      if (!identityResponse.ok) {
        throw new Error("Provider identity request failed");
      }
      const identity = parseExternalIdentity(await identityResponse.json());
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
      return tokenResponseCredential(tokens, expiresIn, credential.refreshToken);
    },

    isAccessTokenInvalid(response) {
      return response.status === 401;
    },

    async revokeCredential(credential) {
      await oauth.tokenRevocation(configuration, credential.accessToken);
    },
  };
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider identity response is invalid");
  }
  const identity = value as Record<string, unknown>;
  if (typeof identity.userId !== "string" || !identity.userId.trim()) {
    throw new Error("Provider identity is missing userId");
  }
  return {
    userId: identity.userId,
    ...(typeof identity.displayName === "string" && identity.displayName.trim()
      ? { displayName: identity.displayName }
      : {}),
    ...(typeof identity.avatarUrl === "string" && identity.avatarUrl.trim()
      ? { avatarUrl: identity.avatarUrl }
      : {}),
  };
}

function required(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
