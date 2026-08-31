import { nanoid } from "nanoid";

import type { CanvasAgentPhase } from "../types";

export const CANVAS_AGENT_ACTION_NAMES = [
    "get_canvas_summary",
    "get_selected_nodes",
    "query_canvas_nodes",
    "get_node",
    "get_upstream_nodes",
    "get_downstream_nodes",
    "get_connected_nodes",
    "get_generation_config",
    "get_generation_task",
    "read_skill_file",
    "set_agent_state",
    "create_primary_script_node",
    "create_text_node",
    "update_text_node",
    "update_node",
    "delete_node",
    "create_connection",
    "delete_connection",
    "create_group",
    "arrange_nodes",
    "generate_image",
    "edit_image",
    "generate_video",
    "generate_audio",
    "get_media_task_status",
] as const;

export type CanvasAgentActionName = (typeof CANVAS_AGENT_ACTION_NAMES)[number];

export type CanvasAgentAction = {
    id: string;
    name: CanvasAgentActionName;
    arguments: Record<string, unknown>;
};

export type CanvasAgentToolResult = {
    ok: boolean;
    code?: string;
    message?: string;
    [key: string]: unknown;
};

export type CanvasAgentToolDefinition = {
    type: "function";
    function: {
        name: CanvasAgentActionName;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required?: string[];
            additionalProperties: false;
        };
    };
};

export type ParsedCanvasAgentJson = {
    parsed: boolean;
    actions: CanvasAgentAction[];
    reply: string;
};

const STRING = { type: "string" };
const STRING_ARRAY = { type: "array", items: { type: "string" }, maxItems: 50 };
const PHASES: CanvasAgentPhase[] = ["intake", "concept", "script", "breakdown", "references", "storyboard", "video", "audio", "review", "complete"];
const NODE_TYPES = ["image", "panorama", "text", "config", "video", "audio", "director", "group"];
const ACTION_NAME_SET = new Set<string>(CANVAS_AGENT_ACTION_NAMES);

function defineTool(name: CanvasAgentActionName, description: string, properties: Record<string, unknown> = {}, required?: string[]): CanvasAgentToolDefinition {
    return {
        type: "function",
        function: {
            name,
            description,
            parameters: {
                type: "object",
                properties,
                required,
                additionalProperties: false,
            },
        },
    };
}

export const CANVAS_AGENT_SKILL_FILE_TOOL = defineTool("read_skill_file", "按相对路径读取当前激活系统 Skill 的附属 Markdown 或文本文件。仅当 SKILL.md 明确引用附属文件时使用。", { skillId: STRING, path: STRING }, ["skillId", "path"]);

export const CANVAS_AGENT_TOOLS: CanvasAgentToolDefinition[] = [
    defineTool("get_canvas_summary", "读取当前画布摘要、节点、连线、模型配置和任务状态。"),
    defineTool("get_selected_nodes", "读取用户当前选中的真实画布节点。"),
    defineTool("query_canvas_nodes", "当默认上下文中没有目标节点 ID 时，按 ID、关键词或类型只读查询画布节点；找到 ID 后再用 get_node 读取详情。", {
        nodeId: STRING,
        keyword: STRING,
        type: { type: "string", enum: NODE_TYPES },
        page: { type: "number", minimum: 1 },
        pageSize: { type: "number", minimum: 1, maximum: 50 },
    }),
    defineTool("get_node", "按真实节点 ID 读取节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_upstream_nodes", "读取指定节点的所有直接上游节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_downstream_nodes", "读取指定节点的所有直接下游节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_connected_nodes", "读取指定节点直接连接的上下游节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_generation_config", "读取全局模型和渠道，以及当前画布 Agent 独立保存的图片质量、图片尺寸、视频清晰度、视频尺寸、时长和声音配置。"),
    defineTool("get_generation_task", "读取指定媒体节点的真实生成任务状态。", { nodeId: STRING }, ["nodeId"]),
    defineTool(
        "set_agent_state",
        "保存当前创作阶段、已确认方案和正式参考，供刷新后继续。",
        {
            phase: { type: "string", enum: PHASES },
            brief: STRING,
            targetDurationSeconds: { type: "number", minimum: 1 },
            approvedPlan: STRING,
            approvedNodeIds: STRING_ARRAY,
            referenceNodeIds: STRING_ARRAY,
        },
        ["phase"],
    ),
    defineTool(
        "create_primary_script_node",
        "仅用于新创作流程首次创建正式主剧本或总制作稿，固定使用主剧本节点尺寸。",
        { title: STRING, content: STRING, sourceNodeIds: STRING_ARRAY, projectTitle: STRING },
        ["title", "content", "projectTitle"],
    ),
    defineTool(
        "create_text_node",
        "创建镜头、角色、产品、场景、声音说明和其他普通文本节点；不得用于首次正式主剧本。",
        { title: STRING, content: STRING, sourceNodeIds: STRING_ARRAY },
        ["title", "content"],
    ),
    defineTool("update_text_node", "更新现有文本节点的标题或正文。", { nodeId: STRING, title: STRING, content: STRING }, ["nodeId"]),
    defineTool("update_node", "只更新现有节点标题；不允许任意字段覆盖。", { nodeId: STRING, title: STRING }, ["nodeId", "title"]),
    defineTool("delete_node", "使用画布现有删除链路删除节点及关联连线。", { nodeId: STRING }, ["nodeId"]),
    defineTool("create_connection", "在两个真实节点之间创建来源连线。", { fromNodeId: STRING, toNodeId: STRING }, ["fromNodeId", "toNodeId"]),
    defineTool("delete_connection", "删除指定真实连线。", { connectionId: STRING }, ["connectionId"]),
    defineTool("create_group", "把两个或更多节点放进本项目 group 节点。", { title: STRING, nodeIds: STRING_ARRAY }, ["nodeIds"]),
    defineTool("arrange_nodes", "整理指定节点；不传 nodeIds 时整理当前画布顶层节点。", { nodeIds: STRING_ARRAY }),
    defineTool(
        "generate_image",
        "创建图片节点和来源连线，并按 Agent 自动生成设置决定是否提交现有图片任务链路。sourceNodeIds 只放真实直接来源，独立生成必须传空数组；其中图片按数组顺序编号为图片1、图片2。",
        {
            prompt: STRING,
            title: STRING,
            sourceNodeIds: STRING_ARRAY,
            size: STRING,
            count: { type: "number", minimum: 1, maximum: 15 },
        },
        ["prompt", "sourceNodeIds"],
    ),
    defineTool(
        "edit_image",
        "创建图片编辑节点和来源连线，并按 Agent 自动生成设置决定是否提交现有图片编辑链路；必须提供至少一个真实图片来源节点，图片按 sourceNodeIds 顺序编号。",
        { prompt: STRING, title: STRING, sourceNodeIds: STRING_ARRAY, size: STRING, count: { type: "number", minimum: 1, maximum: 15 } },
        ["prompt", "sourceNodeIds"],
    ),
    defineTool(
        "generate_video",
        "创建视频节点和来源连线，并按 Agent 自动生成设置决定是否提交现有视频任务链路。sourceNodeIds 只放真实直接来源，独立生成必须传空数组；其中图片、视频、音频分别按各自顺序编号。",
        {
            prompt: STRING,
            title: STRING,
            sourceNodeIds: STRING_ARRAY,
            size: STRING,
            seconds: { type: "number", minimum: -1, maximum: 30 },
            generateAudio: { type: "boolean" },
        },
        ["prompt", "sourceNodeIds"],
    ),
    defineTool(
        "generate_audio",
        "创建音频节点和来源连线，并按 Agent 自动生成设置决定是否提交现有音频任务链路。prompt 是实际朗读文本，instructions 是音色/演绎说明；sourceNodeIds 只放真实直接来源，独立生成必须传空数组。",
        { prompt: STRING, title: STRING, sourceNodeIds: STRING_ARRAY, voice: STRING, instructions: STRING },
        ["prompt", "sourceNodeIds"],
    ),
    defineTool("get_media_task_status", "读取图片、视频或音频节点的生成状态。", { nodeId: STRING }, ["nodeId"]),
];

export function normalizeCanvasAgentAction(name: unknown, args: unknown, id = nanoid()): CanvasAgentAction {
    if (typeof name !== "string" || !ACTION_NAME_SET.has(name)) throw new Error("模型返回了不允许的工具");
    const input = isRecord(args) ? args : {};
    const actionName = name as CanvasAgentActionName;
    let normalized: Record<string, unknown> = {};

    switch (actionName) {
        case "get_canvas_summary":
        case "get_selected_nodes":
        case "get_generation_config":
            break;
        case "query_canvas_nodes": {
            const nodeType = optionalString(input.type);
            if (nodeType && !NODE_TYPES.includes(nodeType)) throw new Error("无效的节点类型");
            normalized = {
                ...(optionalString(input.nodeId) ? { nodeId: optionalString(input.nodeId) } : {}),
                ...(optionalString(input.keyword) ? { keyword: optionalString(input.keyword) } : {}),
                ...(nodeType ? { type: nodeType } : {}),
                page: boundedInteger(input.page, 1, Number.MAX_SAFE_INTEGER) || 1,
                pageSize: boundedInteger(input.pageSize, 1, 50) || 20,
            };
            break;
        }
        case "get_node":
        case "get_upstream_nodes":
        case "get_downstream_nodes":
        case "get_connected_nodes":
        case "get_generation_task":
        case "get_media_task_status":
        case "delete_node":
            normalized = { nodeId: requiredString(input.nodeId, "nodeId") };
            break;
        case "read_skill_file":
            normalized = { skillId: requiredString(input.skillId, "skillId"), path: requiredString(input.path, "path") };
            break;
        case "delete_connection":
            normalized = { connectionId: requiredString(input.connectionId, "connectionId") };
            break;
        case "create_connection":
            normalized = {
                fromNodeId: requiredString(input.fromNodeId, "fromNodeId"),
                toNodeId: requiredString(input.toNodeId, "toNodeId"),
            };
            break;
        case "create_primary_script_node":
            normalized = {
                title: requiredString(input.title, "title"),
                content: requiredString(input.content, "content"),
                sourceNodeIds: stringArray(input.sourceNodeIds),
                projectTitle: requiredString(input.projectTitle, "projectTitle"),
            };
            break;
        case "create_text_node":
            normalized = {
                title: requiredString(input.title, "title"),
                content: requiredString(input.content, "content"),
                sourceNodeIds: stringArray(input.sourceNodeIds),
            };
            break;
        case "update_text_node":
            normalized = {
                nodeId: requiredString(input.nodeId, "nodeId"),
                ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}),
                ...(optionalString(input.content) ? { content: optionalString(input.content) } : {}),
            };
            if (!normalized.title && !normalized.content) throw new Error("update_text_node 缺少 title 或 content");
            break;
        case "update_node":
            normalized = { nodeId: requiredString(input.nodeId, "nodeId"), title: requiredString(input.title, "title") };
            break;
        case "set_agent_state": {
            const phase = requiredString(input.phase, "phase") as CanvasAgentPhase;
            if (!PHASES.includes(phase)) throw new Error("无效的 Agent 创作阶段");
            normalized = {
                phase,
                ...(optionalString(input.brief) ? { brief: optionalString(input.brief) } : {}),
                ...(positiveNumber(input.targetDurationSeconds) ? { targetDurationSeconds: positiveNumber(input.targetDurationSeconds) } : {}),
                ...(optionalString(input.approvedPlan) ? { approvedPlan: optionalString(input.approvedPlan) } : {}),
                ...(Array.isArray(input.approvedNodeIds) ? { approvedNodeIds: stringArray(input.approvedNodeIds) } : {}),
                ...(Array.isArray(input.referenceNodeIds) ? { referenceNodeIds: stringArray(input.referenceNodeIds) } : {}),
            };
            break;
        }
        case "create_group": {
            const nodeIds = stringArray(input.nodeIds);
            if (nodeIds.length < 2) throw new Error("create_group 至少需要两个节点");
            normalized = { nodeIds, ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}) };
            break;
        }
        case "arrange_nodes":
            normalized = { nodeIds: stringArray(input.nodeIds) };
            break;
        case "generate_image":
        case "edit_image": {
            const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
            normalized = {
                prompt: requiredString(input.prompt, "prompt"),
                ...(sourceNodeIds ? { sourceNodeIds } : {}),
                ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}),
                ...(optionalString(input.size) ? { size: optionalString(input.size) } : {}),
                ...(boundedInteger(input.count, 1, 15) ? { count: boundedInteger(input.count, 1, 15) } : {}),
            };
            if (actionName === "edit_image" && sourceNodeIds && !sourceNodeIds.length) throw new Error("edit_image 缺少图片来源节点");
            break;
        }
        case "generate_video": {
            const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
            normalized = {
                prompt: requiredString(input.prompt, "prompt"),
                ...(sourceNodeIds ? { sourceNodeIds } : {}),
                ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}),
                ...(optionalString(input.size) ? { size: optionalString(input.size) } : {}),
                ...(boundedNumber(input.seconds, -1, 30) !== undefined ? { seconds: boundedNumber(input.seconds, -1, 30) } : {}),
                ...(typeof input.generateAudio === "boolean" ? { generateAudio: input.generateAudio } : {}),
            };
            break;
        }
        case "generate_audio": {
            const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
            normalized = {
                prompt: requiredString(input.prompt, "prompt"),
                ...(sourceNodeIds ? { sourceNodeIds } : {}),
                ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}),
                ...(optionalString(input.voice) ? { voice: optionalString(input.voice) } : {}),
                ...(optionalString(input.instructions) ? { instructions: optionalString(input.instructions) } : {}),
            };
            break;
        }
    }

    return { id, name: actionName, arguments: normalized };
}

export function parseCanvasAgentJson(content: string): ParsedCanvasAgentJson {
    const json = extractJsonObject(content);
    if (!json) return { parsed: false, actions: [], reply: content.trim() };
    try {
        const payload = JSON.parse(json) as { actions?: Array<{ id?: string; tool?: string; name?: string; arguments?: unknown }>; reply?: unknown };
        if (!Array.isArray(payload.actions)) return { parsed: false, actions: [], reply: content.trim() };
        const actions = payload.actions.slice(0, 12).map((item) => normalizeCanvasAgentAction(item.tool || item.name, item.arguments, item.id || nanoid()));
        return { parsed: true, actions, reply: typeof payload.reply === "string" ? payload.reply.trim() : "" };
    } catch {
        return { parsed: false, actions: [], reply: content.trim() };
    }
}

export function canvasAgentActionLabel(action: CanvasAgentAction) {
    const labels: Record<CanvasAgentActionName, string> = {
        get_canvas_summary: "正在读取画布",
        get_selected_nodes: "正在读取选中节点",
        query_canvas_nodes: "正在查找画布节点",
        get_node: "正在读取节点",
        get_upstream_nodes: "正在读取上游节点",
        get_downstream_nodes: "正在读取下游节点",
        get_connected_nodes: "正在读取关联节点",
        get_generation_config: "正在读取生成配置",
        get_generation_task: "正在读取任务状态",
        read_skill_file: "正在读取 Skill 文件",
        set_agent_state: "正在保存创作进度",
        create_primary_script_node: "正在创建主剧本节点",
        create_text_node: "正在创建文本节点",
        update_text_node: "正在更新文本节点",
        update_node: "正在更新节点",
        delete_node: "正在删除节点",
        create_connection: "正在创建连线",
        delete_connection: "正在删除连线",
        create_group: "正在创建分组",
        arrange_nodes: "正在整理画布",
        generate_image: "正在创建图片节点",
        edit_image: "正在创建图片编辑节点",
        generate_video: "正在创建视频节点",
        generate_audio: "正在创建音频节点",
        get_media_task_status: "正在读取媒体任务",
    };
    return labels[action.name];
}

export function isCanvasAgentMediaAction(action: CanvasAgentAction) {
    return action.name === "generate_image" || action.name === "edit_image" || action.name === "generate_video" || action.name === "generate_audio";
}

export function userLikelyRequestedCanvasAction(text: string) {
    const action = /(?:创建|新增|插入|修改|更新|删除|连接|连线|分组|整理|生成|生图|执行|拆成|拆分|放到画布|开始做|(?:做|制作|添加|补充|移除|去掉).{0,8}(?:视频|音频|配音|旁白))/i;
    const negated = /(?:不要|别|无需|不用|不)(?:.{0,12})?(?:创建|新增|插入|修改|更新|删除|连接|连线|分组|整理|生成|生图|执行|拆成|拆分|放到画布|开始做|(?:做|制作|添加|补充|移除|去掉).{0,8}(?:视频|音频|配音|旁白))/i;
    return action.test(text) && !negated.test(text);
}

function extractJsonObject(content: string) {
    const trimmed = content.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    return start >= 0 && end > start ? trimmed.slice(start, end + 1) : "";
}

function requiredString(value: unknown, key: string) {
    const text = optionalString(value);
    if (!text) throw new Error(key + " 不能为空");
    return text;
}

function optionalString(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 50);
}

function optionalStringArray(value: unknown, key: string) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error(key + " 必须是字符串数组");
    return stringArray(value);
}

function positiveNumber(value: unknown) {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function boundedInteger(value: unknown, min: number, max: number) {
    const number = boundedNumber(value, min, max);
    return number === undefined ? undefined : Math.floor(number);
}

function boundedNumber(value: unknown, min: number, max: number) {
    if (value === undefined || value === null || value === "") return undefined;
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || number < min || number > max) throw new Error("数值必须在 " + min + " 到 " + max + " 之间");
    return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
