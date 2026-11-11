export type ChannelTranslation = { channelId: string; parameterTranslation: string };
export type TranslationVariable = readonly [label: string, name: string, type: string, description: string];

export const translationVariableGroups = {
    common: [
        ["当前模型", "model", "string", "本次选中的模型"],
        ["提示词", "prompt", "string", "本次已经准备好的提示词"],
    ],
    image: [
        ["尺寸", "size", "string", "当前图片尺寸"],
        ["宽高比", "aspectRatio", "string", "当前图片比例"],
        ["图片质量", "quality", "string", "当前图片质量"],
        ["生成数量", "count", "number", "本次实际请求数量"],
        ["参考图片", "images", "string[]", "普通参考图片的可用地址"],
    ],
    video: [
        ["尺寸", "size", "string", "当前视频尺寸"],
        ["宽高比", "aspectRatio", "string", "当前视频比例"],
        ["视频分辨率", "resolution", "string", "当前视频分辨率"],
        ["视频时长", "seconds", "number", "当前视频时长"],
        ["视频模式", "mode", "string", "面板已有的视频模式"],
        ["样片任务ID", "draftTaskId", "string", "转成片时为原样片任务 ID，普通生成时为空；非空时按该站接口文档组织转成片请求"],
        ["负面提示词", "negativePrompt", "string", "当前负面提示词"],
        ["生成音频", "generateAudio", "boolean", "当前生成音频开关"],
        ["水印", "watermark", "boolean", "当前水印开关"],
        ["参考图片", "images", "string[]", "普通参考图片的可用地址"],
        ["参考视频", "videos", "string[]", "普通参考视频的可用地址"],
        ["参考音频", "audios", "string[]", "普通参考音频的可用地址"],
        ["首帧", "firstFrame", "string", "首帧地址；未指定时为空字符串"],
        ["尾帧", "lastFrame", "string", "尾帧地址；未指定时为空字符串"],
    ],
    audio: [
        ["音色", "voice", "string", "当前音频面板的有效音色"],
        ["音频格式", "audioFormat", "string", "当前有效音频格式"],
        ["语速", "speed", "number", "当前有效语速"],
        ["音频指令", "instructions", "string", "当前有效音频指令"],
        ["参考音频", "audios", "string[]", "已有参考音频的可用地址"],
    ],
} as const satisfies Record<string, readonly TranslationVariable[]>;

export const translationVariableNames = [
    ...new Set(
        Object.values(translationVariableGroups)
            .flat()
            .map((item) => item[1]),
    ),
];
export type TranslationVariables = Partial<Record<(typeof translationVariableNames)[number], string | number | boolean | string[]>>;
export const translationMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export const translationConfigItems: readonly (readonly [label: string, code: string, description: string])[] = [
    ["添加模型配置", 'models: { "模型名称": {} },', "填写当前渠道真实模型名称"],
    ...translationMethods.map((method) => [`${method} 请求`, `${method}: {},`, "在花括号内填写请求配置"] as const),
    ["接口地址", 'url: "",', "相对路径或完整地址"],
    ["请求头", "headers: {},", "接口文档要求的请求头"],
    ["Authorization 请求头", 'Authorization: "Bearer {channelKey}",', "发送时读取当前渠道已有密钥"],
    ["X-API-Key 请求头", '"X-API-Key": "{channelKey}",', "发送时读取当前渠道已有密钥"],
    ["Content-Type 请求头", '"Content-Type": "application/json",', "按实际编码填写；表单上传边界由系统生成"],
    ["Accept 请求头", 'Accept: "application/json",', "接口返回的数据格式"],
    ["URL 查询参数", "params: {},", "放在 URL 查询字符串里的参数"],
    ["请求体", "body: {},", "按接口文档组织实际发送的字段"],
    ["请求体格式", 'format: "json",', "json / formData / urlencoded / raw"],
    ["返回数据格式", 'responseType: "json",', "json / text / blob / arraybuffer"],
    ["结果提取", 'result: "",', "结果字段路径或同步函数"],
    ["错误提取", 'error: "",', "特殊接口的错误字段路径或同步函数"],
    ["添加任务查询", "poll: {},", "返回任务 ID 的接口填写查询规则"],
    ["任务 ID 提取", 'taskId: "",', "在 poll 内填写任务 ID 路径或同步函数"],
    ["查询请求", "GET: {},", "插入 poll 内；方法和字段与提交请求一致"],
    ["引用任务 ID", '"{taskId}"', "查询时替换成提交返回的任务 ID"],
    ["状态提取", 'status: "",', "在 poll 内填写状态路径或同步函数"],
    ["完成状态值", "success: [],", "接口文档规定的完成值"],
    ["失败状态值", "failure: [],", "接口文档规定的失败值"],
    ["进度提取", 'progress: "",', "可选；进度路径或同步函数"],
];

export const translationRuleHint = "写成一份 JavaScript 对象，用 models 按真实模型名分别配置请求方法、url、headers、body。面板变量直接引用，固定值直接填写，接口字段按文档组织。";
export const translationResultHint = "用 result 提取图片、视频或音频结果；异步接口在 poll 中填写任务 ID、查询请求和状态，由系统查询并取得最终结果。";
export const translationTemplate = (model = "模型名称") =>
    `{\n  models: {\n    ${JSON.stringify(model || "模型名称")}: {\n      POST: {\n        url: "/generate",\n        headers: { Authorization: "Bearer {channelKey}" },\n        body: { model, prompt },\n        format: "json",\n        responseType: "json"\n      },\n      result: "data.images"\n    }\n  }\n}`;

export function translationAuthoringPrompt(models: string[] = [], baseUrl = "") {
    const groupNames: Record<string, string> = { common: "通用", image: "图片", video: "视频", audio: "音频" };
    const variables = Object.entries(translationVariableGroups).flatMap(([group, items]) =>
        items.map(([label, name, type, description]) => [label, name, type, `${groupNames[group]}：${description}`] as const),
    );
    return [
        `请为 Infinite Canvas 编写一份渠道自定传参转译配置，统一支持图片、视频、音频，按 models 区分真实模型名称。当前渠道已选模型：${models.length ? models.join("、") : "按渠道模型列表填写"}。`,
        `当前渠道 Base URL：${baseUrl || "未填写，请先确认渠道地址"}。`,
        translationRuleHint,
        "只输出完整 JavaScript 对象表达式，不用 Markdown 代码围栏、import、async function、request、return 或手写轮询循环。",
        "",
        "返回要求",
        translationResultHint,
        "result、error、poll.taskId、poll.status、poll.progress 支持点路径或同步提取函数，数组索引用点路径，例如 data.0.task_id。函数参数由你定义，不是新增面板变量。",
        "",
        "全部可用变量",
        ...translationVariableNames.map((name) => {
            const items = variables.filter((item) => item[1] === name);
            const [label, , type] = items[0]!;
            return `- ${name} (${type})：${label}，${items.map((item) => item[3]).join("；")}`;
        }),
        "",
        "配置字段和插入片段",
        ...translationConfigItems.map(([label, code, description]) => `- ${label}：${code} ${description}`),
        "",
        "配置规则",
        "- 顶层仅支持 models、可选的共用 headers 和可选的共用 poll。models 的键必须与真实模型名称精确匹配；多个模型并列填写。",
        "- 每个模型配置包含且仅包含一种生成请求方法块，及可选的 result、error、poll。空配置、空模型块和未配置的模型使用系统默认调用。",
        "- 每个请求块必须有 url，可选 headers、params、body、format、responseType。相对 url 追加到上述 Base URL 的已有路径后；系统不会自动补齐或去重 /v1 等路径前缀，请按接口文档填写剩余路径。完整地址直接使用。",
        "- format 支持 json、formData、urlencoded、raw；responseType 支持 json、text、blob、arraybuffer；默认均为 json。",
        "- 鉴权使用外面已填写的渠道密钥，模板只使用 {channelKey}，不另填 apiKey。FormData 的 Content-Type 边界由系统生成。",
        "- poll 中填写 taskId、一种查询请求方法块、status、非空 success 数组；failure 按文档填写，progress 可省略。查询地址或参数使用 {taskId}。模型 poll 省略时继承渠道 poll，false 表示关闭，对象表示完整覆盖。",
        "- body、params 和 headers 按目标接口文档平铺或嵌套，字段名不固定。固定字符串带引号；引用面板变量不带引号。可选变量没有值时可以是 undefined，JSON 对象中的 undefined 字段不发送。",
        "- 素材变量都是 URL/Data URL 字符串或字符串数组。没有普通参考素材时为 []，没有首尾帧时为空字符串；表单编码不会把 URL 自动变成文件。",
        "- 同名模型按现有素材输入组织 body。接口要求首尾帧与普通参考互斥时，有 firstFrame 或 lastFrame 就只发送首尾帧字段；否则发送普通参考字段；没有素材时按文生请求填写。不新增生成方式或面板变量。",
        "- result 提取媒体 URL、Data URL 或图片结果数组；直接返回二进制时可省略 result。error 可省略，沿用系统错误处理。",
        "- 视频的同站 /videos/{id}/content 结果地址沿用请求头，并补入结果地址缺少的原请求查询参数；结果地址已有查询字段保持原值。标准 GET /videos/{taskId} 查询完成且未配置 result、没有媒体地址时，系统在原查询路径后追加 /content；明确填错 result 仍报错。",
        "",
        "完整结构示例（地址、请求字段和结果路径必须按目标接口文档修改）",
        translationTemplate(models[0]),
    ].join("\n");
}

// 只读取静态模型名称；保存校验不运行用户的请求表达式或响应函数。
const translationProgramsCache = new Map<string, Record<string, string>>();

export async function translationPrograms(source: string): Promise<Record<string, string>> {
    if (!source.trim()) return {};
    const cached = translationProgramsCache.get(source);
    if (cached) return cached;
    new Function(...translationVariableNames, `"use strict"; return (${source}\n);`);
    const { javascriptLanguage } = await import("@codemirror/lang-javascript");
    const text = `(${source}\n)`;
    const tree = javascriptLanguage.parser.parse(text);
    let invalid = false;
    tree.iterate({
        enter(node) {
            if (node.type.isError) invalid = true;
        },
    });
    if (invalid) throw new Error("配置语法不正确，请检查括号和字段");
    const root = tree.topNode.firstChild?.firstChild?.getChild("ObjectExpression");
    if (!root) throw new Error("渠道配置必须是一份对象：{ models: { ... } }");
    const key = (node: typeof tree.topNode) => {
        const name = node.firstChild;
        if (!name || !["PropertyDefinition", "String"].includes(name.name)) throw new Error("配置字段和模型名称必须使用静态名称");
        const value = text.slice(name.from, name.to);
        if (node.getChild("ParamList") || !node.getChild(":")) throw new Error("配置字段必须使用字段名和值");
        return name.name === "String" ? String(new Function(`return (${value});`)()) : value;
    };
    const fields = root.getChildren("Property");
    if (root.getChildren("Spread").length || fields.some((field) => !["models", "headers", "poll"].includes(key(field)))) throw new Error("渠道顶层只支持 models、headers、poll");
    if (new Set(fields.map(key)).size !== fields.length) throw new Error("渠道顶层字段不能重复");
    const validatePoll = (field?: typeof tree.topNode) => {
        if (!field) return;
        const object = field.getChild("ObjectExpression");
        const value = field.lastChild;
        if (!object) {
            if (!value || text.slice(value.from, value.to) !== "false") throw new Error("poll 必须是查询配置对象或 false");
            return;
        }
        const properties = object.getChildren("Property");
        if (object.getChildren("Spread").length || new Set(properties.map(key)).size !== properties.length) throw new Error("查询配置必须使用不重复的静态字段名");
    };
    validatePoll(fields.find((field) => key(field) === "poll"));
    const models = fields.find((field) => key(field) === "models")?.getChild("ObjectExpression");
    if (!models || models.getChildren("Spread").length) throw new Error("请在 models 中逐个填写真实模型名称和配置");
    const entries = models.getChildren("Property").map((field) => {
        const name = key(field);
        const rule = field.getChild("ObjectExpression");
        if (!name.trim() || !rule) throw new Error("每个模型必须有明确名称和配置对象");
        const requests = rule.getChildren("Property").filter((item) => translationMethods.includes(key(item) as (typeof translationMethods)[number]));
        if (rule.getChildren("Property").length && requests.length !== 1) throw new Error(`模型 ${name} 必须填写且仅填写一种请求方法`);
        if (rule.getChildren("Spread").length) throw new Error(`模型 ${name} 的请求方法必须明确填写`);
        if (requests.some((request) => !request.getChild("ObjectExpression"))) throw new Error(`模型 ${name} 的请求必须是配置对象`);
        if (new Set(rule.getChildren("Property").map(key)).size !== rule.getChildren("Property").length) throw new Error(`模型 ${name} 的配置字段不能重复`);
        validatePoll(rule.getChildren("Property").find((field) => key(field) === "poll"));
        return { name, configured: requests.length === 1, rule: text.slice(rule.from, rule.to) };
    });
    if (new Set(entries.map((item) => item.name)).size !== entries.length) throw new Error("模型名称不能重复");
    const fragment = (name: string, fallback: string) => {
        const field = fields.find((item) => key(item) === name);
        const value = field?.lastChild;
        return value ? text.slice(value.from, value.to) : fallback;
    };
    const programs = Object.fromEntries(entries.filter((item) => item.configured).map((item) => [item.name, `({headers:(${fragment("headers", "{}")}),poll:(${fragment("poll", "false")}),rule:(${item.rule})})`]));
    if (translationProgramsCache.size >= 32) translationProgramsCache.delete(translationProgramsCache.keys().next().value!);
    translationProgramsCache.set(source, programs);
    return programs;
}
