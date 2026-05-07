import { ProviderV2 } from '@ai-sdk/provider';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { API_URL } from '../config/env.js';

async function getRowboatAccessToken(): Promise<string> {
    const { getAccessToken } = await import('../auth/tokens.js');
    return getAccessToken();
}

const authedFetch: typeof fetch = async (input, init) => {
    const token = await getRowboatAccessToken();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
};

export function getGatewayProvider(): ProviderV2 {
    return createOpenRouter({
        baseURL: `${API_URL}/v1/llm`,
        apiKey: 'managed-by-rowboat',
        fetch: authedFetch,
    });
}

type ProviderSummary = {
    id: string;
    name: string;
    models: Array<{
        id: string;
        name?: string;
        release_date?: string;
    }>;
};

export async function listGatewayModels(): Promise<{ providers: ProviderSummary[] }> {
    const accessToken = await getRowboatAccessToken();
    const response = await fetch(`${API_URL}/v1/llm/models`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
        throw new Error(`Gateway /v1/models failed: ${response.status}`);
    }
    const body = await response.json() as { data: Array<{ id: string }> };
    const models = body.data.map((m) => ({ id: m.id }));
    return {
        providers: [{
            id: 'rowboat',
            name: 'Rowboat',
            models,
        }],
    };
}
