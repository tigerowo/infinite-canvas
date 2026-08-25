export type ProviderKind = "api" | "cli";
export type ProviderStatus = "untested" | "connected" | "failed" | "timeout" | "disabled" | "unavailable";
export type ProviderCapability = "text" | "image" | "video" | "audio";
export type ProviderProtocol = "openai" | "gemini" | "http" | "grok2api" | "metaso" | "apimart" | "kie" | "mimo" | "runninghub" | "volcengine" | "codex" | "gemini-cli" | "jimeng";
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

export type CLIHelperResult = {
    available: boolean;
    protocol: string;
    executable?: string;
    version?: string;
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
    status: "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED";
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

export function providerModelChannels(providers: Provider[]) {
    return providers
        .filter((provider) => provider.kind === "api" && managedProviderProtocols.has(provider.protocol))
        .map((provider) => ({
            id: provider.id,
            protocol: provider.protocol as ManagedProviderProtocol,
            name: provider.name,
            baseUrl: provider.baseUrl,
            apiKey: "",
            models: provider.models,
            capabilities: provider.capabilities,
            defaultModel: provider.defaultModel,
            managed: true as const,
            hasApiKey: provider.hasApiKey,
            hasHeaders: provider.hasHeaders,
            enabled: provider.enabled,
            isDefault: provider.isDefault,
        }));
}

export function isRunningHubReference(value: string) {
    return /^(app|workflow):[0-9]{6,32}$/.test(value.trim().toLowerCase());
}
