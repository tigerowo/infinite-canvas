export type ProviderKind = "api" | "cli";
export type ProviderStatus = "untested" | "connected" | "failed" | "timeout" | "disabled" | "unavailable";
export type ProviderCapability = "text" | "image" | "video" | "audio";
export type ProviderProtocol = "openai" | "gemini" | "http" | "grok2api" | "metaso" | "apimart" | "kie" | "mimo" | "runninghub" | "volcengine" | "codex" | "codex-image-emergency" | "gpt-image-2" | "gemini-cli" | "gemini-official-cli" | "jimeng" | "chatgpt-subscription-proxy" | "antigravity-subscription-proxy";
export type ManagedProviderProtocol = "openai" | "gemini" | "http" | "grok2api" | "metaso" | "apimart" | "kie" | "mimo" | "volcengine";

export type Provider = {
    id: string;
    kind: ProviderKind;
    protocol: ProviderProtocol;
    name: string;
    baseUrl: string;
    hasApiKey: boolean;
    apiKeyMasked: string;
    hasHeaders: boolean;
    headerNames: string[];
    capabilities: ProviderCapability[];
    models: string[];
    verifiedModels: string[];
    defaultModel: string;
    timeout: number;
    enabled: boolean;
    isDefault: boolean;
    sortOrder: number;
    connectionStatus: ProviderStatus;
    statusMessage: string;
    lastCheckedAt: string;
    executable: string;
    workingDirectory: string;
    version: string;
    createdAt: string;
    updatedAt: string;
};

export type ProviderInput = {
    id?: string;
    kind: ProviderKind;
    protocol: ProviderProtocol;
    name: string;
    baseUrl?: string;
    apiKey?: string;
    clearApiKey?: boolean;
    headers?: Record<string, string>;
    clearHeaders?: boolean;
    capabilities?: ProviderCapability[];
    models?: string[];
    defaultModel?: string;
    timeout?: number;
    enabled?: boolean;
    isDefault?: boolean;
    executable?: string;
    workingDirectory?: string;
};

export type ProviderTestResult = {
    status: ProviderStatus;
    message: string;
    models?: string[];
    checkedAt: string;
};

export type CLIAccountSummary = {
    userName: string;
    vipLevel: string;
    totalCredit: string;
};

export type CLIHelperResult = {
    available: boolean;
    protocol: string;
    executable?: string;
    version?: string;
    authStatus?: "authenticated" | "unauthenticated" | "unsupported";
    actionStatus?: "started" | "running" | "unsupported";
    taskId?: string;
    taskStatus?: "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
    output?: string;
    model?: string;
    models?: string[];
    account?: CLIAccountSummary;
    message: string;
};

export type RunningHubNodeInfo = {
    nodeId: string;
    fieldName: string;
    fieldValue: unknown;
    description?: string;
    fieldData?: unknown;
};

export type RunningHubTaskResult = {
    taskId: string;
    status: "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";
    errorMessage?: string;
    results?: Array<{ url: string; outputType: string; nodeId?: string }>;
};

export type ProviderMigrationItem = {
    sourceId: string;
    name: string;
    protocol: string;
    baseUrl: string;
    models: string[];
    hasApiKey: boolean;
    action: "import" | "reuse" | "invalid";
    existingProviderId?: string;
    issue?: string;
};

export type ProviderMigrationPreview = {
    total: number;
    importable: number;
    reusable: number;
    invalid: number;
    plaintextSecrets: number;
    items: ProviderMigrationItem[];
};

export type ProviderMigrationResult = {
    importedCount: number;
    reusedCount: number;
    cleanedSecrets: number;
    mappings: Array<{ sourceId: string; providerId: string }>;
    providers: Provider[];
};

export const managedProviderProtocols = new Set<ProviderProtocol>(["openai", "gemini", "http", "grok2api", "metaso", "apimart", "kie", "mimo", "volcengine"]);
export const CODEX_CLI_DEFAULT_MODEL = "codex-cli-default";
export const CODEX_EMERGENCY_IMAGE_MODEL = "codex-image-emergency";
export const GPT_IMAGE_2_SUBSCRIPTION_MODEL = "gpt-image-2";
export const GEMINI_CLI_IMAGE_MODEL = "nano-banana-2";
export const CHATGPT_SUBSCRIPTION_PROXY_PROTOCOL = "chatgpt-subscription-proxy";
export const ANTIGRAVITY_SUBSCRIPTION_PROXY_PROTOCOL = "antigravity-subscription-proxy";

export function providerModelChannels(providers: Provider[]) {
    return providers
        .filter(
            (provider) =>
                (provider.kind === "api" && managedProviderProtocols.has(provider.protocol)) ||
                (provider.kind === "cli" && ["codex", "codex-image-emergency", "gpt-image-2", "gemini-cli", "gemini-official-cli", "jimeng", CHATGPT_SUBSCRIPTION_PROXY_PROTOCOL, ANTIGRAVITY_SUBSCRIPTION_PROXY_PROTOCOL].includes(provider.protocol)),
        )
        .map((provider) => {
            const providerModels = provider.models || [];
            const models = provider.kind === "cli" ? providerModels.filter((model) => provider.verifiedModels?.includes(model)) : providerModels;
            return {
                id: provider.id,
                protocol: provider.protocol as ManagedProviderProtocol | "codex" | "codex-image-emergency" | "gpt-image-2" | "gemini-cli" | "gemini-official-cli" | "jimeng" | "chatgpt-subscription-proxy" | "antigravity-subscription-proxy",
                name: provider.name,
                baseUrl: provider.baseUrl,
                apiKey: "",
                models,
                capabilities: provider.protocol === "codex" ? ["text" as const] : provider.capabilities,
                defaultModel: models.includes(provider.defaultModel) ? provider.defaultModel : models[0] || "",
                managed: true as const,
                hasApiKey: provider.hasApiKey,
                hasHeaders: provider.hasHeaders,
                enabled: provider.enabled,
                isDefault: provider.isDefault,
                connectionStatus: provider.connectionStatus,
                statusMessage: provider.statusMessage,
            };
        });
}

export function isRunningHubReference(value: string) {
    return /^(app|workflow):[0-9]{6,32}$/.test(value.trim().toLowerCase());
}
