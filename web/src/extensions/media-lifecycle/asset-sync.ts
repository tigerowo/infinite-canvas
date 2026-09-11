export type AssetCollection<T> = { assets: T[]; revision: string };

function equal(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const left = Object.keys(a), right = Object.keys(b);
    return left.length === right.length && left.every((key) => Object.hasOwn(b, key) && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function mergeFields(base: unknown, local: unknown, remote: unknown, path: string): unknown {
    if (equal(local, base)) return remote;
    if (equal(remote, base) || equal(local, remote)) return local;
    if (local && remote && base && typeof local === "object" && typeof remote === "object" && typeof base === "object" && !Array.isArray(local) && !Array.isArray(remote)) {
        const original = base as Record<string, unknown>, current = local as Record<string, unknown>, incoming = remote as Record<string, unknown>;
        return Object.fromEntries([...new Set([...Object.keys(original), ...Object.keys(current), ...Object.keys(incoming)])].map((key) => [key,
            key === "updatedAt" ? current[key] : mergeFields(original[key], current[key], incoming[key], `${path}.${key}`),
        ]).filter(([, value]) => value !== undefined));
    }
    throw new Error(`同一素材已在其他浏览器修改（${path.split(".")[0]}），请导出本机修改后刷新核对`);
}

// Deletion wins for a previously known ID. Only genuinely new local IDs are
// added to the latest server collection; client clocks never decide conflicts.
export function mergeAssetCollection<T extends { id: string }>(base: T[], local: T[], remote: T[]): T[] {
    const original = new Map(base.map((item) => [item.id, item]));
    const current = new Map(local.map((item) => [item.id, item]));
    const incoming = new Map(remote.map((item) => [item.id, item]));
    const result: T[] = [];
    for (const item of remote) {
        const previous = original.get(item.id), edited = current.get(item.id);
        if (previous && !edited) continue;
        result.push(edited ? mergeFields(previous, edited, item, item.id) as T : item);
    }
    for (const item of local) if (!original.has(item.id) && !incoming.has(item.id)) result.push(item);
    return result;
}

export async function synchronizeAssetCollection<T extends { id: string }>(input: {
    base: AssetCollection<T> | null;
    local: T[];
    read: () => Promise<AssetCollection<T>>;
    write: (data: AssetCollection<T>) => Promise<AssetCollection<T>>;
    check: () => void;
}): Promise<AssetCollection<T>> {
    input.check();
    if (!input.base && input.local.length) throw new Error("本机素材缺少同步基线，请先导出保留后重新载入云端素材");
    for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await input.read();
        input.check();
        if (!remote.revision || !Array.isArray(remote.assets)) throw new Error("素材同步接口未提供有效版本，请检查服务版本");
        const assets = mergeAssetCollection(input.base?.assets || [], input.local, remote.assets);
        if (equal(assets, remote.assets)) return remote;
        try {
            const accepted = await input.write({ ...remote, assets });
            input.check();
            return accepted;
        } catch (error) {
            input.check();
            if (!(error instanceof Error) || !error.message.startsWith("数据版本已变化") || attempt === 2) throw error;
        }
    }
    throw new Error("素材同步冲突，请稍后重试");
}
