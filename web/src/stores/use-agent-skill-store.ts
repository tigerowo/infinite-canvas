"use client";

import localforage from "localforage";
import { nanoid } from "nanoid";
import { create } from "zustand";

import { AGENT_SKILL_CONTENT_MAX_LENGTH, deleteUserAgentSkill, fetchSystemAgentSkills, fetchUserAgentSkills, saveUserAgentSkill, type AgentSkill } from "@/services/api/agent-skills";
import { deleteStoredImages } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";

type AgentSkillStore = {
    systemSkills: AgentSkill[];
    userSkills: AgentSkill[];
    isLoading: boolean;
    loadSkills: () => Promise<void>;
    importSkill: (file: File) => Promise<AgentSkill>;
    updateSkill: (id: string, patch: Pick<AgentSkill, "name" | "description" | "coverUrl" | "coverStorageKey" | "content">) => Promise<AgentSkill>;
    deleteSkill: (id: string) => Promise<void>;
};

const localSkillStore = localforage.createInstance({ name: "infinite-canvas", storeName: "agent_skills" });
const localSkillKey = "items";
let loadedSkillsKey = "";
let loadSkillsPromise: Promise<void> | null = null;

export function invalidateAgentSkillCache() {
    loadedSkillsKey = "";
}

export const useAgentSkillStore = create<AgentSkillStore>((set, get) => ({
    systemSkills: [],
    userSkills: [],
    isLoading: false,
    loadSkills: async () => {
        const token = useUserStore.getState().token;
        const key = token || "local";
        if (loadedSkillsKey === key) return;
        if (loadSkillsPromise) await loadSkillsPromise;
        if (loadedSkillsKey === key) return;
        set({ isLoading: true });
        loadSkillsPromise = Promise.all([
            fetchSystemAgentSkills(),
            token ? fetchUserAgentSkills(token) : loadLocalAgentSkills(),
        ]).then(([systemSkills, userSkills]) => {
            loadedSkillsKey = key;
            set({ systemSkills, userSkills });
        }).finally(() => {
            loadSkillsPromise = null;
            set({ isLoading: false });
        });
        return loadSkillsPromise;
    },
    importSkill: async (file) => {
        const content = (await file.text()).trim();
        if (!content) throw new Error("Skill 内容不能为空");
        if (Array.from(content).length > AGENT_SKILL_CONTENT_MAX_LENGTH) throw new Error("Skill 内容不能超过 20000 字");
        const name = file.name.replace(/\.(?:md|markdown|txt)$/i, "").trim() || "未命名 Skill";
        const token = useUserStore.getState().token;
        const now = new Date().toISOString();
        const skill = token
            ? await saveUserAgentSkill(token, { name, content })
            : { id: `local-skill-${nanoid()}`, ownerUserId: "", source: "user" as const, name, description: "", coverUrl: "", coverStorageKey: "", content, enabled: true, sort: 0, createdAt: now, updatedAt: now };
        const userSkills = [skill, ...get().userSkills.filter((item) => item.id !== skill.id)];
        if (!token) await localSkillStore.setItem(localSkillKey, userSkills);
        set({ userSkills });
        return skill;
    },
    updateSkill: async (id, patch) => {
        const existing = get().userSkills.find((item) => item.id === id);
        if (!existing) throw new Error("Skill 不存在");
        const name = patch.name.trim();
        const content = patch.content.trim();
        if (!name) throw new Error("请输入 Skill 名称");
        if (!content) throw new Error("请输入 Skill 内容");
        if (Array.from(content).length > AGENT_SKILL_CONTENT_MAX_LENGTH) throw new Error("Skill 内容不能超过 20000 字");
        const token = useUserStore.getState().token;
        const next = { ...existing, ...patch, name, description: patch.description.trim(), coverUrl: patch.coverUrl.trim(), coverStorageKey: patch.coverStorageKey.trim(), content };
        const skill = token
            ? await saveUserAgentSkill(token, next)
            : { ...next, updatedAt: new Date().toISOString() };
        const userSkills = get().userSkills.map((item) => item.id === id ? skill : item);
        if (!token) await localSkillStore.setItem(localSkillKey, userSkills);
        set({ userSkills });
        if (existing.coverStorageKey && existing.coverStorageKey !== skill.coverStorageKey) await deleteStoredImages([existing.coverStorageKey]).catch(() => undefined);
        return skill;
    },
    deleteSkill: async (id) => {
        const token = useUserStore.getState().token;
        if (token) await deleteUserAgentSkill(token, id);
        const coverStorageKey = get().userSkills.find((item) => item.id === id)?.coverStorageKey;
        const userSkills = get().userSkills.filter((item) => item.id !== id);
        if (!token) await localSkillStore.setItem(localSkillKey, userSkills);
        set({ userSkills });
        if (coverStorageKey) await deleteStoredImages([coverStorageKey]).catch(() => undefined);
    },
}));

export async function loadLocalAgentSkills() {
    const items = await localSkillStore.getItem<AgentSkill[]>(localSkillKey);
    return Array.isArray(items) ? items : [];
}
