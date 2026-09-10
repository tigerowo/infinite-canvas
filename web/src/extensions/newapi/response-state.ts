export function responsesImageState(event: Record<string, unknown>) {
    const response = event.response && typeof event.response === "object" ? event.response as Record<string, unknown> : event;
    const type = String(event.type || "");
    const status = String(response.status || "");
    if (["response.failed", "response.incomplete", "response.cancelled"].includes(type) || ["failed", "incomplete", "cancelled", "canceled"].includes(status)) {
        const error = response.error as { message?: string } | undefined;
        throw new Error(error?.message || "图片生成未完成，请重试");
    }
    return (type === "response.completed" || status === "completed") && (!status || status === "completed");
}
