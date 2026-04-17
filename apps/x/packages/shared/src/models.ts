import { z } from "zod";

export const LlmProvider = z.object({
  flavor: z.enum(["openai", "anthropic", "google", "openrouter", "aigateway", "ollama", "openai-compatible"]),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const LlmProviderMode = z.enum(["byok", "rowboat", "chatgpt-codex"]);

const BaseModelSelection = {
  model: z.string(),
  models: z.array(z.string()).optional(),
  knowledgeGraphModel: z.string().optional(),
  meetingNotesModel: z.string().optional(),
};

const LlmByokModelConfig = z.object({
  providerMode: z.literal("byok"),
  provider: LlmProvider,
  ...BaseModelSelection,
});

const LlmAccountModelConfig = z.object({
  model: z.string(),
  models: z.array(z.string()).optional(),
  knowledgeGraphModel: z.string().optional(),
  meetingNotesModel: z.string().optional(),
});

export const LlmModelConfig = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return record.providerMode ? record : { providerMode: "byok", ...record };
}, z.discriminatedUnion("providerMode", [
  LlmByokModelConfig,
  z.object({
    providerMode: z.literal("rowboat"),
    ...LlmAccountModelConfig.shape,
  }),
  z.object({
    providerMode: z.literal("chatgpt-codex"),
    ...LlmAccountModelConfig.shape,
  }),
]));

export const LlmModelTestRequest = z.object({
  provider: LlmProvider,
  model: z.string(),
});
