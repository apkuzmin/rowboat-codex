import { shell } from 'electron';
import type { Server } from 'http';
import { createAuthServer } from './auth-server.js';
import * as oauthClient from '@x/core/dist/auth/oauth-client.js';
import type { Configuration } from '@x/core/dist/auth/oauth-client.js';
import { getProviderConfig, getAvailableProviders } from '@x/core/dist/auth/providers.js';
import container from '@x/core/dist/di/container.js';
import { IOAuthRepo } from '@x/core/dist/auth/repo.js';
import { IClientRegistrationRepo } from '@x/core/dist/auth/client-repo.js';
import { triggerSync as triggerGmailSync } from '@x/core/dist/knowledge/sync_gmail.js';
import { triggerSync as triggerCalendarSync } from '@x/core/dist/knowledge/sync_calendar.js';
import { triggerSync as triggerFirefliesSync } from '@x/core/dist/knowledge/sync_fireflies.js';
import type { IModelConfigRepo } from '@x/core/dist/models/repo.js';
import {
  buildCodexAuthorizationUrl,
  CHATGPT_CODEX_PROVIDER,
  CHATGPT_CODEX_REDIRECT_URI,
  exchangeCodexAuthorizationCode,
  generateCodeChallenge,
  generateCodeVerifier,
  generateCodexState,
  getCodexAccessToken,
  isChatGptCodexEnabled,
  pollCodexDeviceAuthorization,
  requestCodexDeviceCode,
} from '@x/core/dist/auth/codex.js';
import { normalizeCodexModelConfig } from '@x/core/dist/models/codex.js';
import { emitOAuthEvent } from './ipc.js';
import { getBillingInfo } from '@x/core/dist/billing/billing.js';
import { capture as analyticsCapture, identify as analyticsIdentify, reset as analyticsReset } from '@x/core/dist/analytics/posthog.js';

const REDIRECT_URI = 'http://localhost:8080/oauth/callback';
const CODEX_CALLBACK_PATH = '/auth/callback';
const CODEX_CALLBACK_PORT = 1455;

/** Top-level openid-client messages that often wrap a more specific cause. */
const OPAQUE_OAUTH_TOP_MESSAGES = new Set(['invalid response encountered']);

function firstCauseMessage(error: unknown): string | undefined {
  if (error == null || typeof error !== 'object' || !('cause' in error)) {
    return undefined;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message.trim()) {
    return cause.message;
  }
  if (typeof cause === 'string' && cause.trim()) {
    return cause;
  }
  return undefined;
}

/**
 * User-facing message for token-exchange failures. Prefer the first cause message when
 * the top-level message is opaque (common for openid-client) or when code is OAUTH_INVALID_RESPONSE.
 * The catch block below still logs the full cause chain for any error; this helper stays conservative.
 */
function getOAuthErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  const code = error != null && typeof error === 'object' && 'code' in error
    ? (error as { code?: string }).code
    : undefined;
  const causeMsg = firstCauseMessage(error);
  if (code === 'OAUTH_INVALID_RESPONSE' && causeMsg) {
    return causeMsg;
  }
  if (causeMsg && OPAQUE_OAUTH_TOP_MESSAGES.has(msg.trim().toLowerCase())) {
    return causeMsg;
  }
  return msg;
}

// Store active OAuth flows (state -> { codeVerifier, provider, config })
const activeFlows = new Map<string, {
  codeVerifier: string;
  provider: string;
  config: Configuration;
}>();

// Module-level state for tracking the active OAuth flow
interface ActiveOAuthFlow {
  provider: string;
  state: string;
  server: Server;
  cleanupTimeout: NodeJS.Timeout;
}

let activeFlow: ActiveOAuthFlow | null = null;

/**
 * Cancel any active OAuth flow, cleaning up resources
 */
function cancelActiveFlow(reason: string = 'cancelled'): void {
  if (!activeFlow) {
    return;
  }

  console.log(`[OAuth] Cancelling active flow for ${activeFlow.provider}: ${reason}`);

  clearTimeout(activeFlow.cleanupTimeout);
  activeFlow.server.close();
  activeFlows.delete(activeFlow.state);

  // Only emit event for user-visible cancellations
  if (reason !== 'new_flow_started') {
    const message = reason === 'timed_out'
      ? 'Authentication timed out before the browser callback completed.'
      : `OAuth flow ${reason}`;
    emitOAuthEvent({
      provider: activeFlow.provider,
      success: false,
      error: message,
    });
  }

  activeFlow = null;
}

/**
 * Get OAuth repository from DI container
 */
function getOAuthRepo(): IOAuthRepo {
  return container.resolve('oauthRepo') as IOAuthRepo;
}

async function ensureCodexModelDefaults(): Promise<void> {
  const modelConfigRepo = container.resolve('modelConfigRepo') as IModelConfigRepo;
  const config = await modelConfigRepo.getConfig();
  if ((config.providerMode ?? 'byok') !== CHATGPT_CODEX_PROVIDER) {
    return;
  }
  const normalized = await normalizeCodexModelConfig(config);
  if (normalized.changed) {
    await modelConfigRepo.setConfig(normalized.config);
  }
}

async function persistCodexConnection(result: {
  tokens: {
    access_token: string;
    refresh_token: string | null;
    expires_at: number;
    token_type?: 'Bearer';
    scopes?: string[];
  };
  metadata: {
    email?: string | null;
    accountId?: string | null;
    planType?: string | null;
    idToken?: string | null;
    expire?: string | null;
    lastRefresh?: string | null;
  };
}): Promise<void> {
  const oauthRepo = getOAuthRepo();
  await oauthRepo.upsert(CHATGPT_CODEX_PROVIDER, {
    tokens: result.tokens,
    metadata: result.metadata,
    error: null,
  });
}

function codexErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  if (message.includes('already in use')) {
    return 'Codex login could not start because local callback port 1455 is already in use.';
  }
  if (message.includes('timed out')) {
    return 'Codex login timed out before authentication completed.';
  }
  if (message.toLowerCase().includes('state mismatch')) {
    return 'Codex login failed because the callback state did not match the active sign-in attempt.';
  }
  return message;
}

async function connectCodexBrowserProvider(): Promise<{ success: boolean; error?: string; deviceCode?: string; verificationUrl?: string }> {
  if (!isChatGptCodexEnabled()) {
    return { success: false, error: 'ChatGPT / Codex provider is disabled.' };
  }

  try {
    cancelActiveFlow('new_flow_started');

    const state = generateCodexState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const authUrl = buildCodexAuthorizationUrl(state, codeChallenge);

    let callbackHandled = false;
    const { server } = await createAuthServer(
      CODEX_CALLBACK_PORT,
      async (callbackUrl) => {
        if (callbackHandled) return;
        callbackHandled = true;

        const receivedState = callbackUrl.searchParams.get('state');
        const error = callbackUrl.searchParams.get('error');
        if (error) {
          const errorMessage = callbackUrl.searchParams.get('error_description') || error;
          emitOAuthEvent({ provider: CHATGPT_CODEX_PROVIDER, success: false, error: errorMessage });
          return;
        }
        if (!receivedState) {
          emitOAuthEvent({
            provider: CHATGPT_CODEX_PROVIDER,
            success: false,
            error: 'Codex callback missing state parameter.',
          });
          return;
        }
        if (receivedState !== state) {
          emitOAuthEvent({
            provider: CHATGPT_CODEX_PROVIDER,
            success: false,
            error: 'Codex callback state mismatch.',
          });
          return;
        }

        const code = callbackUrl.searchParams.get('code');
        if (!code) {
          emitOAuthEvent({
            provider: CHATGPT_CODEX_PROVIDER,
            success: false,
            error: 'Codex callback missing authorization code.',
          });
          return;
        }

        try {
          const tokens = await exchangeCodexAuthorizationCode(code, codeVerifier, CHATGPT_CODEX_REDIRECT_URI);
          await persistCodexConnection(tokens);
          await ensureCodexModelDefaults();
          emitOAuthEvent({
            provider: CHATGPT_CODEX_PROVIDER,
            success: true,
            email: tokens.metadata.email ?? undefined,
            planType: tokens.metadata.planType ?? undefined,
          });
        } catch (exchangeError) {
          const errorMessage = codexErrorMessage(exchangeError);
          await getOAuthRepo().upsert(CHATGPT_CODEX_PROVIDER, { error: errorMessage });
          emitOAuthEvent({ provider: CHATGPT_CODEX_PROVIDER, success: false, error: errorMessage });
        } finally {
          if (activeFlow?.state === state) {
            clearTimeout(activeFlow.cleanupTimeout);
            activeFlow.server.close();
            activeFlow = null;
          }
        }
      },
      { callbackPath: CODEX_CALLBACK_PATH },
    );

    const cleanupTimeout = setTimeout(() => {
      if (activeFlow?.state === state) {
        cancelActiveFlow('timed_out');
      }
    }, 5 * 60 * 1000);

    activeFlow = {
      provider: CHATGPT_CODEX_PROVIDER,
      state,
      server,
      cleanupTimeout,
    };

    shell.openExternal(authUrl.toString());
    return { success: true };
  } catch (error) {
    const errorMessage = codexErrorMessage(error);
    console.error('Codex browser login failed:', error);
    return { success: false, error: errorMessage };
  }
}

async function connectCodexDeviceProvider(): Promise<{ success: boolean; error?: string; deviceCode?: string; verificationUrl?: string }> {
  if (!isChatGptCodexEnabled()) {
    return { success: false, error: 'ChatGPT / Codex provider is disabled.' };
  }

  try {
    const { deviceAuthId, userCode, intervalSeconds, verificationUrl } = await requestCodexDeviceCode();
    shell.openExternal(verificationUrl);

    void (async () => {
      try {
        const tokens = await pollCodexDeviceAuthorization(deviceAuthId, userCode, intervalSeconds);
        await persistCodexConnection(tokens);
        await ensureCodexModelDefaults();
        emitOAuthEvent({
          provider: CHATGPT_CODEX_PROVIDER,
          success: true,
          email: tokens.metadata.email ?? undefined,
          planType: tokens.metadata.planType ?? undefined,
        });
      } catch (deviceError) {
        const errorMessage = codexErrorMessage(deviceError);
        await getOAuthRepo().upsert(CHATGPT_CODEX_PROVIDER, { error: errorMessage });
        emitOAuthEvent({ provider: CHATGPT_CODEX_PROVIDER, success: false, error: errorMessage });
      }
    })();

    return {
      success: true,
      deviceCode: userCode,
      verificationUrl,
    };
  } catch (error) {
    const errorMessage = codexErrorMessage(error);
    console.error('Codex device login failed:', error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Get client registration repository from DI container
 */
function getClientRegistrationRepo(): IClientRegistrationRepo {
  return container.resolve('clientRegistrationRepo') as IClientRegistrationRepo;
}

/**
 * Get or create OAuth configuration for a provider
 */
async function getProviderConfiguration(provider: string, credentialsOverride?: { clientId: string; clientSecret: string }): Promise<Configuration> {
  const config = await getProviderConfig(provider);
  const resolveClientCredentials = async (): Promise<{ clientId: string; clientSecret?: string }> => {
    if (config.client.mode === 'static' && config.client.clientId) {
      return { clientId: config.client.clientId, clientSecret: credentialsOverride?.clientSecret };
    }
    if (credentialsOverride) {
      return { clientId: credentialsOverride.clientId, clientSecret: credentialsOverride.clientSecret };
    }
    const oauthRepo = getOAuthRepo();
    const connection = await oauthRepo.read(provider);
    if (connection.clientId) {
      return { clientId: connection.clientId, clientSecret: connection.clientSecret ?? undefined };
    }
    throw new Error(`${provider} client ID not configured. Please provide a client ID.`);
  };

  if (config.discovery.mode === 'issuer') {
    if (config.client.mode === 'static') {
      // Discover endpoints, use static client ID
      console.log(`[OAuth] ${provider}: Discovery from issuer with static client ID`);
      const { clientId, clientSecret } = await resolveClientCredentials();
      return await oauthClient.discoverConfiguration(
        config.discovery.issuer,
        clientId,
        clientSecret
      );
    } else {
      // DCR mode - check for existing registration or register new
      console.log(`[OAuth] ${provider}: Discovery from issuer with DCR`);
      const clientRepo = getClientRegistrationRepo();
      const existingRegistration = await clientRepo.getClientRegistration(provider);
      
      if (existingRegistration) {
        console.log(`[OAuth] ${provider}: Using existing DCR registration`);
        return await oauthClient.discoverConfiguration(
          config.discovery.issuer,
          existingRegistration.client_id
        );
      }

      // Register new client
      const scopes = config.scopes || [];
      const { config: oauthConfig, registration } = await oauthClient.registerClient(
        config.discovery.issuer,
        [REDIRECT_URI],
        scopes
      );
      
      // Save registration for future use
      await clientRepo.saveClientRegistration(provider, registration);
      console.log(`[OAuth] ${provider}: DCR registration saved`);
      
      return oauthConfig;
    }
  } else {
    // Static endpoints mode
    if (config.client.mode !== 'static') {
      throw new Error('DCR requires discovery mode "issuer", not "static"');
    }
    
    console.log(`[OAuth] ${provider}: Using static endpoints (no discovery)`);
    const { clientId, clientSecret } = await resolveClientCredentials();
    return oauthClient.createStaticConfiguration(
      config.discovery.authorizationEndpoint,
      config.discovery.tokenEndpoint,
      clientId,
      config.discovery.revocationEndpoint,
      clientSecret
    );
  }
}

/**
 * Initiate OAuth flow for a provider
 */
export async function connectProvider(
  provider: string,
  credentials?: { clientId: string; clientSecret: string },
  mode: 'browser' | 'device' = 'browser',
): Promise<{ success: boolean; error?: string; deviceCode?: string; verificationUrl?: string }> {
  try {
    console.log(`[OAuth] Starting connection flow for ${provider}...`);

    if (provider === CHATGPT_CODEX_PROVIDER) {
      return mode === 'device'
        ? await connectCodexDeviceProvider()
        : await connectCodexBrowserProvider();
    }

    // Cancel any existing flow before starting a new one
    cancelActiveFlow('new_flow_started');

    const oauthRepo = getOAuthRepo();
    const providerConfig = await getProviderConfig(provider);

    if (provider === 'google') {
      if (!credentials?.clientId || !credentials?.clientSecret) {
        return { success: false, error: 'Google client ID and client secret are required to connect.' };
      }
    }

    // Get or create OAuth configuration
    const config = await getProviderConfiguration(provider, credentials);

    // Generate PKCE codes
    const { verifier: codeVerifier, challenge: codeChallenge } = await oauthClient.generatePKCE();
    const state = oauthClient.generateState();

    // Get scopes from config
    const scopes = providerConfig.scopes || [];

    // Store flow state
    activeFlows.set(state, { codeVerifier, provider, config });

    // Build authorization URL
    const authUrl = oauthClient.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT_URI,
      scope: scopes.join(' '),
      code_challenge: codeChallenge,
      state,
    });

    // Create callback server
    let callbackHandled = false;
    const { server } = await createAuthServer(8080, async (callbackUrl) => {
      // Guard against duplicate callbacks (browser may send multiple requests)
      if (callbackHandled) return;
      callbackHandled = true;
      const receivedState = callbackUrl.searchParams.get('state');
      if (receivedState == null || receivedState === '') {
        throw new Error(
          'OAuth callback missing state parameter. Complete sign-in in the browser or check the redirect URI.'
        );
      }
      if (receivedState !== state) {
        throw new Error('Invalid state parameter - possible CSRF attack');
      }

      const flow = activeFlows.get(state);
      if (!flow || flow.provider !== provider) {
        throw new Error('Invalid OAuth flow state');
      }

      try {
        // Use full callback URL (includes iss, scope, etc.) so openid-client validation succeeds
        console.log(`[OAuth] Exchanging authorization code for tokens (${provider})...`);
        const tokens = await oauthClient.exchangeCodeForTokens(
          flow.config,
          callbackUrl,
          flow.codeVerifier,
          state
        );

        // Save tokens and credentials
        console.log(`[OAuth] Token exchange successful for ${provider}`);
        await oauthRepo.upsert(provider, {
          tokens,
          ...(credentials ? { clientId: credentials.clientId, clientSecret: credentials.clientSecret } : {}),
          error: null,
        });

        // Trigger immediate sync for relevant providers
        if (provider === 'google') {
          triggerGmailSync();
          triggerCalendarSync();
        } else if (provider === 'fireflies-ai') {
          triggerFirefliesSync();
        }

        // For Rowboat sign-in, ensure user + Stripe customer exist before
        // notifying the renderer. Without this, parallel API calls from
        // multiple renderer hooks race to create the user, causing duplicates.
        let signedInUserId: string | undefined;
        if (provider === 'rowboat') {
          try {
            const billing = await getBillingInfo();
            if (billing.userId) {
              signedInUserId = billing.userId;
              analyticsIdentify(billing.userId, {
                ...(billing.userEmail ? { email: billing.userEmail } : {}),
                plan: billing.subscriptionPlan,
                status: billing.subscriptionStatus,
              });
              analyticsCapture('user_signed_in', {
                plan: billing.subscriptionPlan,
                status: billing.subscriptionStatus,
              });
            }
          } catch (meError) {
            console.error('[OAuth] Failed to initialize user via /v1/me:', meError);
          }
        }

        // Emit success event to renderer
        emitOAuthEvent({
          provider,
          success: true,
          ...(signedInUserId ? { userId: signedInUserId } : {}),
        });
      } catch (error) {
        console.error('OAuth token exchange failed:', error);
        // Log cause chain for debugging (e.g. OAUTH_INVALID_RESPONSE -> OperationProcessingError)
        let cause: unknown = error;
        while (cause != null && typeof cause === 'object' && 'cause' in cause) {
          cause = (cause as { cause?: unknown }).cause;
          if (cause != null) {
            console.error('[OAuth] Caused by:', cause);
          }
        }
        const errorMessage = getOAuthErrorMessage(error);
        emitOAuthEvent({ provider, success: false, error: errorMessage });
        throw error;
      } finally {
        // Clean up
        activeFlows.delete(state);
        if (activeFlow && activeFlow.state === state) {
          clearTimeout(activeFlow.cleanupTimeout);
          activeFlow.server.close();
          activeFlow = null;
        }
      }
    });

    // Set timeout to clean up abandoned flows (2 minutes)
    // This prevents memory leaks if user never completes the OAuth flow
    const cleanupTimeout = setTimeout(() => {
      if (activeFlow?.state === state) {
        console.log(`[OAuth] Cleaning up abandoned OAuth flow for ${provider} (timeout)`);
        cancelActiveFlow('timed_out');
      }
    }, 2 * 60 * 1000); // 2 minutes

    // Store complete flow state for cleanup
    activeFlow = {
      provider,
      state,
      server,
      cleanupTimeout,
    };

    // Open in system browser (shares cookies/sessions with user's regular browser)
    shell.openExternal(authUrl.toString());

    // Wait for callback (server will handle it)
    return { success: true };
  } catch (error) {
    console.error('OAuth connection failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Disconnect a provider (clear tokens)
 */
export async function disconnectProvider(provider: string): Promise<{ success: boolean }> {
  try {
    const oauthRepo = getOAuthRepo();
    await oauthRepo.delete(provider);
    if (provider === 'rowboat') {
      analyticsCapture('user_signed_out');
      analyticsReset();
    }
    // Notify renderer so sidebar, voice, and billing re-check state
    emitOAuthEvent({ provider, success: false });
    return { success: true };
  } catch (error) {
    console.error('OAuth disconnect failed:', error);
    return { success: false };
  }
}

/**
 * Get access token for a provider (internal use only)
 * Refreshes token if expired
 */
export async function getAccessToken(provider: string): Promise<string | null> {
  try {
    if (provider === CHATGPT_CODEX_PROVIDER) {
      return await getCodexAccessToken();
    }

    const oauthRepo = getOAuthRepo();

    let { tokens } = await oauthRepo.read(provider);
    if (!tokens) {
      return null;
    }

    // Check if token needs refresh
    if (oauthClient.isTokenExpired(tokens)) {
      if (!tokens.refresh_token) {
        // No refresh token, need to reconnect
        await oauthRepo.upsert(provider, { error: 'Missing refresh token. Please reconnect.' });
        return null;
      }

      try {
        // Get configuration for refresh
        const config = await getProviderConfiguration(provider);

        // Refresh token, preserving existing scopes
        const existingScopes = tokens.scopes;
        const refreshedTokens = await oauthClient.refreshTokens(config, tokens.refresh_token, existingScopes);
        await oauthRepo.upsert(provider, { tokens: refreshedTokens });
        tokens = refreshedTokens;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Token refresh failed';
        await oauthRepo.upsert(provider, { error: message });
        console.error('Token refresh failed:', error);
        return null;
      }
    }

    return tokens.access_token;
  } catch (error) {
    console.error('Get access token failed:', error);
    return null;
  }
}

/**
 * Get list of available providers
 */
export function listProviders(): { providers: string[] } {
  return { providers: getAvailableProviders() };
}
