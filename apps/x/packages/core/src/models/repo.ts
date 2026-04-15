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

    private async loadRawConfig(): Promise<unknown | null> {
        try {
            const config = await fs.readFile(this.configPath, "utf8");
            return JSON.parse(config);
        } catch {
            return null;
        }
    }

    private async parseConfigOrDefault(raw: unknown): Promise<z.infer<typeof ModelConfig>> {
        try {
            return ModelConfig.parse(raw);
        } catch (error) {
            console.warn(
                "[ModelConfigRepo] Invalid models.json detected. Falling back to default config:",
                error instanceof Error ? error.message : String(error),
            );
            await fs.writeFile(this.configPath, JSON.stringify(defaultConfig, null, 2));
            return defaultConfig;
        }
    }

    async ensureConfig(): Promise<void> {
        try {
            await fs.access(this.configPath);
        } catch {
            await fs.writeFile(this.configPath, JSON.stringify(defaultConfig, null, 2));
        }
    }

    async getConfig(): Promise<z.infer<typeof ModelConfig>> {
        const raw = await this.loadRawConfig();
        const parsed = await this.parseConfigOrDefault(raw ?? defaultConfig);
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
        const existing = await this.loadRawConfig();
        if (existing && typeof existing === "object") {
            const existingRecord = existing as Record<string, unknown>;
            existingProviders = (existingRecord.providers as Record<string, Record<string, unknown>> | undefined) || {};
            if (
                existingRecord.provider
                && typeof existingRecord.provider === "object"
                && "flavor" in (existingRecord.provider as Record<string, unknown>)
            ) {
                existingTopLevelProvider = existingRecord.provider as z.infer<typeof ModelConfig>["provider"];
            }
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
