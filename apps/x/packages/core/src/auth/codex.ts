import { createHash, randomBytes } from 'node:crypto';
import z from 'zod';
import container from '../di/container.js';
import { IOAuthRepo } from './repo.js';
import { OAuthTokens } from './types.js';
import { ENABLE_CHATGPT_CODEX_PROVIDER } from '../config/env.js';

export const CHATGPT_CODEX_PROVIDER = 'chatgpt-codex';
export const CHATGPT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CHATGPT_CODEX_DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
export const CHATGPT_CODEX_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
export const CHATGPT_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CHATGPT_CODEX_DEVICE_USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
export const CHATGPT_CODEX_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
export const CHATGPT_CODEX_DEVICE_VERIFICATION_URL = 'https://auth.openai.com/codex/device';
export const CHATGPT_CODEX_ORIGINATOR = 'codex-tui';

const CHATGPT_CODEX_SCOPES = 'openid email profile offline_access';
const DEVICE_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const REFRESH_LEEWAY_SECONDS = 60;

const CodexTokenBundleSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  idToken: z.string().nullable(),
  expiresIn: z.number().int().positive(),
});

const RawCodexTokenBundleSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullable().optional(),
  id_token: z.string().nullable().optional(),
  expires_in: z.number().int().positive(),
});

const CodexClaimsSchema = z.object({
  email: z.string().optional(),
  'https://api.openai.com/auth': z.object({
    chatgpt_account_id: z.string().optional(),
    chatgpt_plan_type: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const CodexDeviceUserCodeSchema = z.object({
  device_auth_id: z.string(),
  user_code: z.string().optional(),
  usercode: z.string().optional(),
  interval: z.union([z.number(), z.string()]).optional(),
});

const CodexDeviceTokenSchema = z.object({
  authorization_code: z.string(),
  code_verifier: z.string(),
  code_challenge: z.string(),
});

export type CodexConnectionMetadata = {
  idToken?: string | null;
  accountId?: string | null;
  email?: string | null;
  expire?: string | null;
  lastRefresh?: string | null;
  planType?: string | null;
};

export type CodexTokenRecord = {
  tokens: OAuthTokens;
  metadata: CodexConnectionMetadata;
};

function getOAuthRepo(): IOAuthRepo {
  return container.resolve<IOAuthRepo>('oauthRepo');
}

function base64UrlEncode(value: Buffer): string {
  return value.toString('base64url');
}

function parseIntervalSeconds(value: string | number | undefined): number {
  if (typeof value === 'number' && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 5;
}

function parseCodexClaims(idToken?: string | null): CodexConnectionMetadata {
  if (!idToken) {
    return {};
  }

  const [, payload] = idToken.split('.');
  if (!payload) {
    return { idToken };
  }

  try {
    const claims = CodexClaimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return {
      idToken,
      email: claims.email ?? null,
      accountId: claims['https://api.openai.com/auth']?.chatgpt_account_id ?? null,
      planType: claims['https://api.openai.com/auth']?.chatgpt_plan_type ?? null,
    };
  } catch {
    return { idToken };
  }
}

function toTokenRecord(bundle: z.infer<typeof CodexTokenBundleSchema>, fallbackRefreshToken?: string | null): CodexTokenRecord {
  const expiresAt = Math.floor(Date.now() / 1000) + bundle.expiresIn;
  const metadata = parseCodexClaims(bundle.idToken);
  const refreshToken = bundle.refreshToken ?? fallbackRefreshToken ?? null;
  return {
    tokens: OAuthTokens.parse({
      access_token: bundle.accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      token_type: 'Bearer',
      scopes: CHATGPT_CODEX_SCOPES.split(' '),
    }),
    metadata: {
      ...metadata,
      expire: new Date(expiresAt * 1000).toISOString(),
      lastRefresh: new Date().toISOString(),
    },
  };
}

export function maskIdentifier(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  if (value.length <= 6) {
    return `${value.slice(0, 2)}***`;
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

export function buildCodexHeaders(
  auth: CodexTokenRecord,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    Accept: 'application/json',
    Originator: CHATGPT_CODEX_ORIGINATOR,
    ...extraHeaders,
    ...(auth.metadata.accountId ? { 'Chatgpt-Account-Id': auth.metadata.accountId } : {}),
  };
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodSchema<T>,
  userFacingError: string,
): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();

  if (!response.ok) {
    const body = text.trim() || `HTTP ${response.status}`;
    throw new Error(`${userFacingError}: ${body}`);
  }

  return schema.parse(JSON.parse(text));
}

export function isChatGptCodexEnabled(): boolean {
  return ENABLE_CHATGPT_CODEX_PROVIDER;
}

export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function generateCodexState(): string {
  return base64UrlEncode(randomBytes(24));
}

export function buildCodexAuthorizationUrl(state: string, codeChallenge: string): URL {
  const url = new URL(CHATGPT_CODEX_AUTH_URL);
  url.searchParams.set('client_id', CHATGPT_CODEX_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', CHATGPT_CODEX_REDIRECT_URI);
  url.searchParams.set('scope', CHATGPT_CODEX_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'login');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  return url;
}

export async function exchangeCodexAuthorizationCode(
  code: string,
  codeVerifier: string,
  redirectUri: string = CHATGPT_CODEX_REDIRECT_URI,
): Promise<CodexTokenRecord> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CHATGPT_CODEX_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const bundle = await fetchJson(
    CHATGPT_CODEX_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
    RawCodexTokenBundleSchema.transform((value) => ({
      accessToken: value.access_token,
      refreshToken: value.refresh_token ?? null,
      idToken: value.id_token ?? null,
      expiresIn: value.expires_in,
    })),
    'Codex code exchange failed',
  );

  return toTokenRecord(bundle);
}

export async function requestCodexDeviceCode(): Promise<{
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  verificationUrl: string;
}> {
  const payload = await fetchJson(
    CHATGPT_CODEX_DEVICE_USER_CODE_URL,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: CHATGPT_CODEX_CLIENT_ID,
      }),
    },
    CodexDeviceUserCodeSchema,
    'Codex device login failed',
  );

  const userCode = payload.user_code?.trim() || payload.usercode?.trim();
  if (!userCode) {
    throw new Error('Codex device login failed: missing device code');
  }

  return {
    deviceAuthId: payload.device_auth_id,
    userCode,
    intervalSeconds: parseIntervalSeconds(payload.interval),
    verificationUrl: CHATGPT_CODEX_DEVICE_VERIFICATION_URL,
  };
}

export async function pollCodexDeviceAuthorization(
  deviceAuthId: string,
  userCode: string,
  intervalSeconds: number,
  signal?: AbortSignal,
): Promise<CodexTokenRecord> {
  const startedAt = Date.now();
  const intervalMs = Math.max(1, intervalSeconds) * 1000;

  while (Date.now() - startedAt < DEVICE_POLL_TIMEOUT_MS) {
    signal?.throwIfAborted();

    const response = await fetch(CHATGPT_CODEX_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
      signal,
    });

    const text = await response.text();

    if (response.ok) {
      const payload = CodexDeviceTokenSchema.parse(JSON.parse(text));
      return await exchangeCodexAuthorizationCode(
        payload.authorization_code,
        payload.code_verifier,
        CHATGPT_CODEX_DEVICE_REDIRECT_URI,
      );
    }

    if (response.status !== 403 && response.status !== 404) {
      const body = text.trim() || `HTTP ${response.status}`;
      throw new Error(`Codex device login failed: ${body}`);
    }

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, intervalMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  throw new Error('Codex device login timed out after 15 minutes');
}

function isExpired(tokens: OAuthTokens): boolean {
  const now = Math.floor(Date.now() / 1000);
  return tokens.expires_at <= now + REFRESH_LEEWAY_SECONDS;
}

function isNonRetryableRefreshError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('invalid_grant')
    || normalized.includes('invalid_request')
    || normalized.includes('unauthorized')
    || normalized.includes('expired_token');
}

async function refreshCodexTokensOnce(refreshToken: string): Promise<CodexTokenRecord> {
  const body = new URLSearchParams({
    client_id: CHATGPT_CODEX_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'openid profile email',
  });

  const bundle = await fetchJson(
    CHATGPT_CODEX_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
    RawCodexTokenBundleSchema.transform((value) => ({
      accessToken: value.access_token,
      refreshToken: value.refresh_token ?? null,
      idToken: value.id_token ?? null,
      expiresIn: value.expires_in,
    })),
    'Codex token refresh failed',
  );

  return toTokenRecord(bundle, refreshToken);
}

export async function refreshCodexTokensWithRetry(refreshToken: string, retries: number = 1): Promise<CodexTokenRecord> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      return await refreshCodexTokensOnce(refreshToken);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : 'Codex token refresh failed';
      if (attempt >= retries || isNonRetryableRefreshError(message)) {
        throw error;
      }
    }
    attempt += 1;
  }

  throw lastError instanceof Error ? lastError : new Error('Codex token refresh failed');
}

export async function getCodexAuthRecord(): Promise<CodexTokenRecord | null> {
  const oauthRepo = getOAuthRepo();
  const connection = await oauthRepo.read(CHATGPT_CODEX_PROVIDER);
  if (!connection.tokens) {
    return null;
  }

  if (!isExpired(connection.tokens)) {
    return {
      tokens: connection.tokens,
      metadata: connection.metadata ?? {},
    };
  }

  if (!connection.tokens.refresh_token) {
    await oauthRepo.upsert(CHATGPT_CODEX_PROVIDER, {
      error: 'ChatGPT session expired. Reconnect your ChatGPT / Codex account.',
    });
    return null;
  }

  try {
    const refreshed = await refreshCodexTokensWithRetry(connection.tokens.refresh_token);
    await oauthRepo.upsert(CHATGPT_CODEX_PROVIDER, {
      tokens: refreshed.tokens,
      metadata: refreshed.metadata,
      error: null,
    });
    console.log(
      `[Codex] refreshed ChatGPT session for ${maskIdentifier(refreshed.metadata.email)} (${maskIdentifier(refreshed.metadata.accountId)})`,
    );
    return refreshed;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Codex token refresh failed';
    await oauthRepo.upsert(CHATGPT_CODEX_PROVIDER, {
      error: message,
    });
    throw error;
  }
}

export async function getCodexAccessToken(): Promise<string | null> {
  const record = await getCodexAuthRecord();
  return record?.tokens.access_token ?? null;
}

export async function isCodexConnected(): Promise<boolean> {
  if (!isChatGptCodexEnabled()) {
    return false;
  }
  const oauthRepo = getOAuthRepo();
  const { tokens } = await oauthRepo.read(CHATGPT_CODEX_PROVIDER);
  return !!tokens;
}
