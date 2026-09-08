export type CodexConnection = { endpoint: string; token: string };
export type CodexRpcEvent = {
    id?: string | number;
    generation: number;
    method: string;
    params: Record<string, unknown> & {
        threadId?: string; turnId?: string; itemId?: string; delta?: string;
        item?: { id: string; type: string; text?: string };
        turn?: { id: string; status: string; error?: { message: string } };
    };
};
export type CodexToolEvent = { requestId: string; source: "codex" | "external"; generation: number; name: string; arguments: Record<string, unknown> };
export type CodexModel = {
    model: string; displayName: string; defaultReasoningEffort: string; isDefault: boolean;
    supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
};
export function normalizeCodexEndpoint(endpoint: string) {
    try {
        const url = new URL(endpoint);
        if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
        return url.origin;
    } catch { throw new Error("本地 Agent 地址必须为 http://127.0.0.1:端口"); }
}
export async function readCodexAgentConfig(endpoint: string): Promise<{ url: string; hasToken: boolean }> {
    const url = normalizeCodexEndpoint(endpoint);
    let response: Response;
    try { response = await fetch(url + "/config", { signal: AbortSignal.timeout(5_000) }); }
    catch { throw new Error("未连接到本地 Agent，请先启动服务，再使用插件自动连接"); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法读取本地 Agent 状态");
    return result;
}
export function createCodexAgentClient(
    connection: CodexConnection,
    canvasId: string,
    tools: unknown[],
    handlers: { rpc: (event: CodexRpcEvent) => void; tool: (event: CodexToolEvent) => void; cancelTool: (requestId: string) => void; ready: () => Promise<void>; error: (error: Error) => void },
) {
    const clientId = crypto.randomUUID();
    const endpoint = normalizeCodexEndpoint(connection.endpoint);
    const lifetime = new AbortController();
    let codexGeneration = 0;
    let serviceId = "";
    const syncCodexGeneration = (generation: number, message: string) => {
        if (!(generation > codexGeneration)) return;
        const previous = codexGeneration;
        codexGeneration = generation;
        handlers.rpc({ generation: previous, method: "bridge/disconnected", params: { message } });
    };
    const request = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
        const response = await fetch(endpoint + path, {
            method: "POST",
            headers: { "content-type": "application/json", "x-canvas-agent-token": connection.token },
            body: JSON.stringify({ clientId, ...body }),
            signal: path === "/rpc" ? lifetime.signal : AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
        });
        const result = await response.json();
        if (path === "/rpc") syncCodexGeneration(Number(response.headers.get("x-canvas-agent-generation")), result?.error || "Codex 连接已断开");
        if (!response.ok && !(path === "/result" && response.status === 409)) throw new Error(result.error || result.msg || "本地 Codex 请求失败");
        return result as T;
    };
    const rpc = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        const generation = codexGeneration;
        let result: T | undefined;
        try { result = await request<T>("/rpc", { method, params, generation }); }
        catch (error) { if (generation === codexGeneration) throw error; }
        if (generation !== codexGeneration) throw new DOMException("Codex 请求已停止", "AbortError");
        return result as T;
    };
    const events = new EventSource(endpoint + "/events?" + new URLSearchParams({ clientId, token: connection.token }));
    const fail = (error: unknown) => {
        if (!lifetime.signal.aborted) handlers.error(error instanceof Error ? error : new Error("本地 Agent 连接已断开"));
    };
    const listen = <T>(name: string, listener: (value: T) => void) => events.addEventListener(name, (event) => {
        try { listener(JSON.parse((event as MessageEvent).data) as T); } catch (error) { fail(error); }
    });
    listen<CodexRpcEvent>("rpc", (event) => {
        if (event.generation !== codexGeneration) return;
        if (event.method === "bridge/disconnected") syncCodexGeneration(event.generation + 1, String(event.params?.message || "Codex 连接已断开"));
        else handlers.rpc({ ...event, params: event.params || {} });
    });
    listen<CodexToolEvent>("tool", (event) => { if (event.source === "external" || event.generation === codexGeneration) handlers.tool(event); });
    listen<{ requestId: string }>("tool-cancel", ({ requestId }) => handlers.cancelTool(requestId));
    events.onopen = () => { void request<{ serviceId: string }>("/connect", { canvasId, tools }).then((result) => { serviceId = result.serviceId; return handlers.ready(); }).catch(fail); };
    events.onerror = () => fail(new Error("本地 Agent 连接已断开，请检查服务和连接配置"));
    return {
        rpc,
        stop: () => { codexGeneration += 1; return rpc("bridge/stop"); },
        get serviceId() { return serviceId; },
        reply: (event: CodexRpcEvent, result?: unknown, error?: { code: number; message: string }) => request("/reply", { id: event.id, generation: event.generation, result, error }),
        result: (requestId: string, result?: unknown, error?: string) => request("/result", { requestId, result, error }),
        connected: () => events.readyState === EventSource.OPEN,
        signal: lifetime.signal,
        close: () => { events.close(); lifetime.abort(); },
    };
}
