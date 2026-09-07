import { create } from "zustand";

export type ModelKind = "text" | "image" | "video" | "audio";
export type ModelPolicy = { imageTransfer: "url" | "base64"; overrides: Record<string, ModelKind> };
export const useModelPolicy = create<{ policy: ModelPolicy; loadedAt: number }>(() => ({
    policy: { imageTransfer: "url", overrides: {} }, loadedAt: 0,
}));
let pending: Promise<ModelPolicy> | undefined;

export function modelTypeOverride(model: string) {
    return useModelPolicy.getState().policy.overrides[model.trim().toLowerCase()];
}

export function clearModelPolicyCache() { useModelPolicy.setState({ loadedAt: 0 }); }

async function policyRequest(init?: RequestInit): Promise<ModelPolicy> {
    const response = await fetch("/api/extensions/model-policy", { cache: "no-store", ...init });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0 || !payload.data) throw new Error(payload.msg || "模型与素材设置读取失败");
    useModelPolicy.setState({ policy: payload.data, loadedAt: Date.now() });
    return payload.data;
}

export async function loadModelPolicy(force = false): Promise<ModelPolicy> {
    const state = useModelPolicy.getState();
    if (!force && Date.now() - state.loadedAt < 5000) return state.policy;
    if (!pending) pending = policyRequest().finally(() => { pending = undefined; });
    return pending;
}

export async function saveModelPolicy(token: string, policy: ModelPolicy) {
    if (pending) await pending.catch(() => {});
    return policyRequest({ method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(policy) });
}
