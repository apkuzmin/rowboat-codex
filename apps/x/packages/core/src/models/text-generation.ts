import { LanguageModel } from 'ai';
import { generateText, streamText } from 'ai';
import { ActiveProviderMode } from './active-provider.js';

type TextGenerationArgs = {
  model: LanguageModel;
  system?: string;
  prompt?: string;
  messages?: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: unknown;
  }>;
  abortSignal?: AbortSignal;
};

type TextGenerationResult = {
  text: string;
  usage?: Awaited<ReturnType<typeof generateText>>['usage'];
};

export async function generateTextForProvider(
  providerMode: ActiveProviderMode,
  args: TextGenerationArgs,
): Promise<TextGenerationResult> {
  if (providerMode !== 'chatgpt-codex') {
    const result = await generateText(args as Parameters<typeof generateText>[0]);
    return {
      text: result.text,
      usage: result.usage,
    };
  }

  const result = streamText(args as Parameters<typeof streamText>[0]);
  const [text, usage] = await Promise.all([result.text, result.totalUsage]);
  return {
    text,
    usage,
  };
}
