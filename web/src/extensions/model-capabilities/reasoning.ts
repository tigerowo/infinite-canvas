export type ReasoningEffort = "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const reasoningLabels: Record<ReasoningEffort, string> = { auto: "自动", none: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高" };

export function reasoningOptions(model: string, protocol: string): ReasoningEffort[] {
    const name = model.trim().toLowerCase();
    if (protocol === "mimo") return ["auto", "high"];
    if (/^gpt-5\.[245](?:-|$)/.test(name) && !name.includes("pro")) return ["auto", "none", "low", "medium", "high", "xhigh"];
    if (/^gpt-5\.1(?:-|$)/.test(name)) return ["auto", "none", "low", "medium", "high"];
    if (/^gpt-5(?:-|$)/.test(name) && !name.includes("pro")) return ["auto", "minimal", "low", "medium", "high"];
    if (/^o[134](?:-|$)/.test(name)) return ["auto", "low", "medium", "high"];
    if (/^gemini-3\.1-pro/.test(name) || /^gemini-3-flash/.test(name)) return ["auto", "low", "medium", "high"];
    if (/^gemini-3(?:\.0)?-pro/.test(name)) return ["auto", "low", "high"];
    return ["auto"];
}

export function resolveReasoning(model: string, protocol: string, effort?: ReasoningEffort, legacyEnabled = false): ReasoningEffort {
    const options = reasoningOptions(model, protocol);
    const selected = effort ?? (legacyEnabled ? "high" : "auto");
    return options.includes(selected) ? selected : "auto";
}

export function reasoningFields(model: string, protocol: string, mode: "chat" | "responses" | "gemini", effort?: ReasoningEffort, legacyEnabled = false): Record<string, unknown> {
    const selected = resolveReasoning(model, protocol, effort, legacyEnabled);
    if (selected === "auto") return {};
    if (mode === "gemini") return { generationConfig: { thinkingConfig: { thinkingLevel: selected } } };
    if (mode === "responses") return { reasoning: { effort: selected } };
    if (protocol === "mimo") return { thinking: { type: "enabled" } };
    return { reasoning_effort: selected };
}
