export type ReasoningEffort = "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const reasoningLabels: Record<ReasoningEffort, string> = { auto: "关闭", none: "关闭", minimal: "低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };

export function reasoningOptions(_model: string, _protocol: string): ReasoningEffort[] {
    return ["none", "low", "medium", "high", "xhigh", "max"];
}

export function resolveReasoning(model: string, protocol: string, effort?: ReasoningEffort, legacyEnabled = false): ReasoningEffort {
    const options = reasoningOptions(model, protocol);
    const selected = effort === "minimal" ? "low" : effort ?? (legacyEnabled ? "high" : "none");
    return options.includes(selected) ? selected : "none";
}

export function reasoningFields(model: string, protocol: string, mode: "chat" | "responses" | "gemini", effort?: ReasoningEffort, legacyEnabled = false): Record<string, unknown> {
    const selected = resolveReasoning(model, protocol, effort, legacyEnabled);
    if (selected === "none") return {};
    if (mode === "gemini") return { generationConfig: { thinkingConfig: { thinkingLevel: selected } } };
    if (mode === "responses") return { reasoning: { effort: selected } };
    if (protocol === "mimo") return { thinking: { type: "enabled" } };
    return { reasoning_effort: selected };
}
