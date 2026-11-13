import type { WorkflowCapability, WorkflowFieldMapping } from "@/lib/workflow-channel";
import { apiPost } from "@/services/api/request";

export type ComfyWorkflowInspectInput = { workflowJson: Record<string, unknown>; capability: WorkflowCapability };
export type ComfyWorkflowInspectResult = { workflowJson: Record<string, unknown>; fields: WorkflowFieldMapping[] };

/** 直连渠道没有 Bridge，由服务端直接解析 API JSON 并推断字段。 */
export function inspectComfyWorkflow(token: string, input: ComfyWorkflowInspectInput) {
    return apiPost<ComfyWorkflowInspectResult>("/api/v1/comfy-workflows/inspect", input, token);
}
