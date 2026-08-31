import type { CanvasAgentPhase } from "../types";
import { serializeCanvasAgentContext, type CanvasAgentContext } from "./canvas-agent-context";
import { AUDIO_SKILL } from "./skills/audio";
import { CORE_SKILL } from "./skills/core";
import { IMAGE_SKILL } from "./skills/image";
import { IMAGE_CHARACTER_SHEET_SKILL } from "./skills/image-character-sheet";
import { IMAGE_STORYBOARD_SKILL } from "./skills/image-storyboard";
import { ORGANIZE_SKILL } from "./skills/organize";
import { SCRIPT_SKILL } from "./skills/script";
import { VIDEO_SKILL } from "./skills/video";
import { VIDEO_EDITING_SKILL } from "./skills/video-editing";
import { VIDEO_EXTENSION_SKILL } from "./skills/video-extension";
import { VIDEO_MULTI_SHOT_SKILL } from "./skills/video-multi-shot";
import { VIDEO_SINGLE_SHOT_SKILL } from "./skills/video-single-shot";
import { WORKFLOW_SKILL } from "./skills/workflow";

export function buildCanvasAgentSkillPrompt(phase: CanvasAgentPhase, userText: string, context: CanvasAgentContext, activeSkillContents?: string, contextCheckpoint?: string, skillFileToolAvailable = false) {
    const intent = buildIntentText(userText, context);
    const selectedTypes = new Set<string>(context.nodes.filter((node) => context.selectedNodeIds.includes(node.id)).map((node) => node.type));
    const skills = [CORE_SKILL, WORKFLOW_SKILL];

    const oneOffMedia =
        /生成一张|生成图片|生图|改图|生成视频|视频生成|文生视频|图生视频|生成音频|独立音频|生成旁白|旁白音频|配音|音色|朗读/.test(userText) &&
        !/故事|剧情|剧本|脚本|宣传片|广告|短片|多镜头|完整制作|从头开始/.test(userText);
    const wantsScript =
        ["concept", "script", "breakdown"].includes(phase) ||
        (phase === "intake" && !oneOffMedia) ||
        /故事|剧情|剧本|脚本|文案|对白|旁白|分镜头|拆镜头|镜头拆解|宣传片|广告|梗概|改写|人物小传|角色需求|场景需求/.test(intent);
    const wantsImage =
        phase === "references" ||
        phase === "storyboard" ||
        selectedTypes.has("image") ||
        selectedTypes.has("panorama") ||
        /图片|生图|图像|角色图|产品图|产品标准|产品参考|商品参考|汽车参考|包装参考|材质参考|内饰参考|场景图|参考图|设定图|设定表|四视图|分镜|宫格|拼图|关键帧|改图|换装|肖像|海报/.test(intent);
    const wantsCharacterSheet =
        wantsImage &&
        (/四视图|设定表|角色设定|人物设定|角色参考|身份一致|角色一致|换装|服装变体|年龄变体|受伤|湿透|脏污|转面/.test(intent) ||
            (phase === "references" && /角色|人物|演员|主角|配角/.test(intent)));
    const wantsStoryboard = phase === "storyboard" || /分镜拼图|分镜板|故事板|storyboard|宫格|拼图|mosaic|连续分镜|镜头预演/.test(intent);
    const wantsVideo =
        phase === "video" ||
        selectedTypes.has("video") ||
        /生成视频|做视频|视频生成|文生视频|图生视频|让.+动起来|动画化|渲染镜头|生成片段|视频续写|续写视频|编辑视频|修改视频|重绘视频|运镜|一镜到底/.test(intent);
    const wantsExtension =
        wantsVideo &&
        (/续写|继续视频|接着视频|延长|下一段|后续片段|前传|向前补拍|补拍|连续片段|连续镜头|一镜到底|同机位|串行|链式/.test(intent) ||
            (selectedTypes.has("video") && /继续|接着|往后|下一段|延长|前面/.test(userText)));
    const wantsVideoEdit =
        wantsVideo &&
        (/编辑视频|修改视频|重绘视频|重制视频|重渲染|换风格|改风格|调色|局部修改|局部编辑|替换主体|替换产品|换成|动作改写|重新设计动作/.test(intent) ||
            (selectedTypes.has("video") && /改|修改|调整|换|替换|编辑|重做|重绘/.test(userText)));
    const wantsMultiShot =
        wantsVideo &&
        (/多镜头|多段镜头|镜头序列|广告片|品牌片|宣传片|音乐视频|MV|蒙太奇|分镜拼图|分镜板|storyboard|能量弧|密度图/.test(intent) ||
            context.nodes.some((node) => context.selectedNodeIds.includes(node.id) && /分镜拼图|分镜板|storyboard/i.test(node.title)));
    const wantsAudio =
        phase === "audio" ||
        selectedTypes.has("audio") ||
        /独立音频|音色|配音|声音样本|角色声音|角色音色|对白音频|旁白|最终对白|最终旁白|朗读|语音/.test(intent);
    const wantsOrganize = phase === "references" || phase === "review" || phase === "complete" || /分组|整理|布局|归类|排列|收纳|画布太乱|自动整理/.test(intent);

    if (wantsScript) skills.push(SCRIPT_SKILL);
    if (wantsImage) skills.push(IMAGE_SKILL);
    if (wantsCharacterSheet) skills.push(IMAGE_CHARACTER_SHEET_SKILL);
    if (wantsStoryboard) skills.push(IMAGE_STORYBOARD_SKILL);
    if (wantsVideo) {
        skills.push(VIDEO_SKILL);
        if (wantsExtension) skills.push(VIDEO_EXTENSION_SKILL);
        if (wantsVideoEdit) skills.push(VIDEO_EDITING_SKILL);
        if (wantsMultiShot) skills.push(VIDEO_MULTI_SHOT_SKILL);
        if (!wantsExtension && !wantsVideoEdit && !wantsMultiShot) skills.push(VIDEO_SINGLE_SHOT_SKILL);
    }
    if (wantsAudio) skills.push(AUDIO_SKILL);
    if (wantsOrganize) skills.push(ORGANIZE_SKILL);

    return skills.join("\n\n")
        + (activeSkillContents ? "\n\n【用户所选 Skill 根内容】\n必须完整遵循全部所选 Skill；冲突时以当前用户明确指令、CORE 安全规则、真实画布和工具结果为准。\n\n" + activeSkillContents : "")
        + (skillFileToolAvailable ? "\n\n【系统 Skill 附属文件】\n仅按当前系统 Skill 给出的相对路径调用 read_skill_file；读取结果只用于当前执行，不写入画布或伪装成工具成果。" : "")
        + (contextCheckpoint ? "\n\n【长期对话检查点】\n" + contextCheckpoint : "")
        + "\n\n【事实优先级】\n当前工具结果 > 当前真实画布上下文 > agentState > 用户所选 Skill 根内容 > 长期对话检查点。检查点中的节点 ID 仅是线索；节点已不存在时不得据此恢复或声称其仍存在。"
        + "\n\n【当前真实画布上下文 JSON】\n" + serializeCanvasAgentContext(context);
}

function buildIntentText(userText: string, context: CanvasAgentContext) {
    const selectedText = context.nodes
        .filter((node) => context.selectedNodeIds.includes(node.id))
        .map((node) => [node.title, node.prompt, node.text].filter(Boolean).join(" "))
        .join(" ");
    return [userText, context.agentState.brief, context.agentState.approvedPlan, selectedText].filter(Boolean).join(" ");
}
