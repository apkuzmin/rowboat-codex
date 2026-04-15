import { ModelConfig } from "./models.js";
import { WorkDir } from "../config/config.js";
import { normalizeCodexModelConfig } from "./codex.js";
import fs from "fs/promises";
import path from "path";
import z from "zod";

export interface IModelConfigRepo {
    ensureConfig(): Promise<void>;
    getConfig(): Promise<z.infer<typeof ModelConfig>>;
    setConfig(config: z.infer<typeof ModelConfig>): Promise<void>;
}

const defaultConfig: z.infer<typeof ModelConfig> = {
    providerMode: "byok",
    provider: {
        flavor: "openai",
    },
    model: "gpt-5.4",
};

export class FSModelConfigRepo implements IModelConfigRepo {
    private readonly configPath = path.join(WorkDir, "config", "models.json");

    async ensureConfig(): Promise<void> {
        try {
            await fs.access(this.configPath);
        } catch {
            await fs.writeFile(this.configPath, JSON.stringify(defaultConfig, null, 2));
        }
    }

    async getConfig(): Promise<z.infer<typeof ModelConfig>> {
        const config = await fs.readFile(this.configPath, "utf8");
        const parsed = ModelConfig.parse(JSON.parse(config));
        const normalized = await normalizeCodexModelConfig(parsed);
        if (normalized.changed) {
            await this.setConfig(normalized.config);
        }
        return normalized.config;
    }

    async setConfig(config: z.infer<typeof ModelConfig>): Promise<void> {
        const normalized = await normalizeCodexModelConfig(config);
        config = normalized.config;
        const providerMode = config.providerMode ?? "byok";
        let existingProviders: Record<string, Record<string, unknown>> = {};
        let existingTopLevelProvider = config.provider;
        try {
            const raw = await fs.readFile(this.configPath, "utf8");
            const existing = JSON.parse(raw);
            existingProviders = existing.providers || {};
            if (existing.provider?.flavor) {
                existingTopLevelProvider = existing.provider;
            }
        } catch {
            // No existing config
        }

        if (providerMode === "byok") {
            existingProviders[config.provider.flavor] = {
                ...existingProviders[config.provider.flavor],
                apiKey: config.provider.apiKey,
                baseURL: config.provider.baseURL,
                headers: config.provider.headers,
                model: config.model,
                models: config.models,
                knowledgeGraphModel: config.knowledgeGraphModel,
                meetingNotesModel: config.meetingNotesModel,
            };
            existingTopLevelProvider = config.provider;
        }

        const toWrite = {
            ...config,
            providerMode,
            provider: existingTopLevelProvider,
            providers: existingProviders,
        };
        await fs.writeFile(this.configPath, JSON.stringify(toWrite, null, 2));
    }
}
