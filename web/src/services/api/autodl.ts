import { apiPost } from "@/services/api/request";

export type AutoDLInputRule = {
    type: string;
    required?: boolean;
    default?: string | number;
    min?: number;
    max?: number;
};

export type AutoDLWorkflow = {
    uuid: string;
    name: string;
    kind: "video" | "audio" | "unsupported";
    input_rules?: Record<string, AutoDLInputRule>;
};

export function fetchAutoDLWorkflows(baseUrl: string) {
    return apiPost<AutoDLWorkflow[]>("/api/ai/autodl/workflows", { baseUrl });
}

export function fetchAutoDLWorkflow(baseUrl: string, workflowId: string) {
    return apiPost<AutoDLWorkflow>("/api/ai/autodl/workflows", { baseUrl, workflowId });
}
