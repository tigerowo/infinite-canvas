import localforage from "localforage";
import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import { listCanvasProjects, saveCanvasProject, syncCanvasProjects } from "@/services/api/canvas-tasks";
import { assertMediaSession, mediaSession } from "./cache";
import { durableMediaSnapshot } from "./snapshot";
import { mergeProjectChanges } from "./project-merge";
import { LifecycleConflict, lifecycleEpoch } from "@/extensions/media-lifecycle/session";

type Pending = { project: CanvasProject; base?: CanvasProject };
type SyncState = { versions: Record<string, string>; bases: Record<string, CanvasProject>; pending: Record<string, Pending>; epoch?: number; reset?: boolean };
const disk = localforage.createInstance({ name: "infinite-canvas", storeName: "ext_canvas_sync" });
const chains = new Map<string, Promise<unknown>>();

function withSync<T>(token: string, run: (state: SyncState, save: () => Promise<unknown>, check: () => void) => Promise<T>) {
    const session = mediaSession();
    if (!session.userId || session.token !== token) return Promise.reject(new Error("账号尚未就绪，请稍后重试同步"));
    const key = `ext:media-reliability:canvas:${session.userId}`;
    const task = (chains.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
        assertMediaSession(session);
        const state = await disk.getItem<SyncState>(key) || { versions: {}, bases: {}, pending: {} };
        const epoch = await lifecycleEpoch(token);
        if ((state.epoch || 1) !== epoch) {
            await disk.setItem(`${key}:recovery:${state.epoch || 1}:${Date.now()}`, state);
            state.versions = Object.fromEntries(Object.keys({ ...state.bases, ...state.pending }).map((id) => [id, "deleted"]));
            state.bases = {}; state.pending = {}; state.reset = true;
        }
        state.epoch = epoch;
        await disk.setItem(key, state);
        assertMediaSession(session);
        return run(state, () => { assertMediaSession(session); return disk.setItem(key, state); }, () => assertMediaSession(session));
    });
    chains.set(key, task);
    void task.finally(() => { if (chains.get(key) === task) chains.delete(key); }).catch(() => {});
    return task;
}

async function flush(token: string, state: SyncState, save: () => Promise<unknown>, check: () => void) {
    for (const [id, pending] of Object.entries(state.pending)) {
        check();
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const baseTime = Date.parse(pending.base?.updatedAt || "");
                if (Number.isFinite(baseTime) && Date.parse(pending.project.updatedAt) <= baseTime) {
                    pending.project = { ...pending.project, updatedAt: new Date(baseTime + 1).toISOString() };
                }
                const saved = await saveCanvasProject(token, pending.project, pending.base?.updatedAt || "");
                check();
                state.versions[id] = saved.updatedAt;
                state.bases[id] = saved;
                delete state.pending[id];
                await save();
                break;
            } catch (error) {
                check();
                if (!(error instanceof Error) || !error.message.includes("画布版本已更新") || attempt === 2) throw error;
                const remote = (await listCanvasProjects(token)).find((project) => project.id === id);
                check();
                if (!remote) {
                    await disk.setItem(`ext:media-lifecycle:recovery:${mediaSession().userId}:${id}:${Date.now()}`, pending);
                    delete state.pending[id];
                    delete state.bases[id];
                    state.versions[id] = "deleted";
                    await save();
                    break;
                }
                pending.project = pending.base ? mergeProjectChanges(pending.base, pending.project, remote) : remote;
                pending.project = { ...pending.project, updatedAt: new Date(Math.max(Date.now(), Date.parse(remote.updatedAt) + 1)).toISOString() };
                pending.base = remote;
                await save();
            }
        }
    }
}

export function saveProjectSnapshot(token: string, project: CanvasProject, upload = true) {
    return withSync(token, async (state, save, check) => {
        if (state.reset) {
            await disk.setItem(`ext:media-lifecycle:recovery:${mediaSession().userId}:${project.id}:${Date.now()}`, project);
            throw new LifecycleConflict();
        }
        const previous = state.pending[project.id];
        state.pending[project.id] = { project: durableMediaSnapshot(project), base: previous?.base ?? state.bases[project.id] };
        await save();
        if (!upload) return project;
        await flush(token, state, save, check);
        return state.bases[project.id] || null;
    });
}

export function readProjectSnapshot(token: string, local: CanvasProject[]) {
    return withSync(token, async (state, save, check) => {
        if (state.reset) {
            await disk.setItem(`ext:media-lifecycle:recovery:${mediaSession().userId}:local:${Date.now()}`, local);
            local.forEach((project) => { state.versions[project.id] = "deleted"; });
            state.reset = false;
            await save();
        }
        await flush(token, state, save, check);
        let remote = await listCanvasProjects(token);
        check();
        // Import genuinely local projects once. Known missing IDs were deleted remotely.
        const ids = new Set(remote.map((project) => project.id));
        const imports = local.filter((project) => !ids.has(project.id) && !(project.id in state.versions));
        if (imports.length) {
            remote = await syncCanvasProjects(token, durableMediaSnapshot(imports));
            check();
            imports.forEach((project) => { state.versions[project.id] = project.updatedAt; });
        }
        state.bases = Object.fromEntries(remote.map((project) => [project.id, project]));
        remote.forEach((project) => { state.versions[project.id] = project.updatedAt; });
        await save();
        return remote;
    });
}

export function forgetProjectSnapshots(token: string, ids: string[]) {
    return withSync(token, async (state, save) => {
        ids.forEach((id) => { delete state.pending[id]; delete state.bases[id]; state.versions[id] = "deleted"; });
        await save();
    });
}
