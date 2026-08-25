import { apiDelete, apiGet, apiPost } from "@/services/api/request";
import type { CLIHelperResult, Provider, ProviderInput, ProviderKind, ProviderMigrationPreview, ProviderMigrationResult, ProviderTestResult, RunningHubNodeInfo, RunningHubTaskResult } from "@/lib/provider";

export function fetchProviders(token: string, kind?: ProviderKind) {
    return apiGet<Provider[]>("/api/v1/providers", kind ? { kind } : undefined, token);
}

export function saveProvider(token: string, input: ProviderInput) {
    return apiPost<Provider>("/api/v1/providers", input, token);
}

export function deleteProvider(token: string, id: string) {
    return apiDelete<boolean>(`/api/v1/providers/${encodeURIComponent(id)}`, token);
}

export function setDefaultProvider(token: string, id: string) {
    return apiPost<Provider>(`/api/v1/providers/${encodeURIComponent(id)}/default`, {}, token);
}

export function testProvider(token: string, id: string, refreshModels = false) {
    return apiPost<ProviderTestResult>(`/api/v1/providers/${encodeURIComponent(id)}/test`, { refreshModels }, token);
}

export function fetchProviderMigrationPreview(token: string) {
    return apiGet<ProviderMigrationPreview>("/api/v1/providers/migration-preview", undefined, token);
}

export function migrateLegacyProviders(token: string, cleanupLegacy: boolean) {
    return apiPost<ProviderMigrationResult>("/api/v1/providers/migrate", { cleanupLegacy }, token);
}

export function detectCLIProvider(token: string, id: string) {
    return apiPost<CLIHelperResult>(`/api/v1/providers/${encodeURIComponent(id)}/cli/detect`, {}, token);
}

export function checkCLIProviderAuth(token: string, id: string) {
    return apiPost<CLIHelperResult>(`/api/v1/providers/${encodeURIComponent(id)}/cli/auth-status`, {}, token);
}

export function submitRunningHubTask(token: string, id: string, reference: string, nodeInfoList: RunningHubNodeInfo[]) {
    return apiPost<RunningHubTaskResult>(`/api/v1/providers/${encodeURIComponent(id)}/runninghub/tasks`, { reference, nodeInfoList }, token);
}

export function queryRunningHubTask(token: string, id: string, taskId: string) {
    return apiGet<RunningHubTaskResult>(`/api/v1/providers/${encodeURIComponent(id)}/runninghub/tasks/${encodeURIComponent(taskId)}`, undefined, token);
}

export function cancelRunningHubTask(token: string, id: string, taskId: string) {
    return apiPost<RunningHubTaskResult>(`/api/v1/providers/${encodeURIComponent(id)}/runninghub/tasks/${encodeURIComponent(taskId)}/cancel`, {}, token);
}
