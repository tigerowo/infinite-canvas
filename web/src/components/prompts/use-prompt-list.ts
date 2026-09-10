"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ALL_PROMPTS_OPTION, fetchPrompts, type Prompt } from "@/services/api/prompts";
import { useUserStore } from "@/stores/use-user-store";

export const PROMPT_PAGE_SIZE = 20;

export function uniquePromptItems(items: Prompt[]): Prompt[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
    });
}

export function promptPageCount(total: number, pageSize: number) {
    const normalizedTotal = Math.max(0, Math.floor(total));
    const normalizedPageSize = Math.max(1, Math.floor(pageSize));
    return Math.max(1, Math.ceil(normalizedTotal / normalizedPageSize));
}

function uniqueOptions(values: string[]) {
    return Array.from(new Set(values.filter((value) => value.trim() && value !== ALL_PROMPTS_OPTION)));
}

export function usePromptList({ keyword, tags, category, page = 1, pageSize = PROMPT_PAGE_SIZE, enabled = true }: { keyword: string; tags: string[]; category: string; page?: number; pageSize?: number; enabled?: boolean }) {
    const isReady = useUserStore((state) => state.isReady);
    const token = useUserStore((state) => state.token);
    const query = useQuery({
        queryKey: ["prompts", keyword, tags, category, page, pageSize],
        queryFn: () => fetchPrompts({ keyword, tag: tags, category, page, pageSize }),
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        enabled: enabled && isReady && Boolean(token),
    });
    const metadataQuery = useQuery({
        queryKey: ["prompts-meta", keyword, tags, category],
        queryFn: () => fetchPrompts({ keyword, tag: tags, category, page: 1, pageSize: 1 }),
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        enabled: enabled && isReady && Boolean(token) && page > 1,
    });
    const firstPage = page === 1 ? query.data : metadataQuery.data;
    return {
        query,
        items: uniquePromptItems(query.data?.items || []),
        tags: useMemo(() => [ALL_PROMPTS_OPTION, ...uniqueOptions(firstPage?.tags || [])], [firstPage?.tags]),
        categories: useMemo(() => [ALL_PROMPTS_OPTION, ...uniqueOptions(firstPage?.categories || [])], [firstPage?.categories]),
        total: query.data?.total || metadataQuery.data?.total || 0,
    };
}
