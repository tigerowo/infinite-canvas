"use client";

import { App, Button, Form, Input, Modal, Segmented, Select, Switch } from "antd";
import { useEffect, useState } from "react";

import { ModelPicker } from "@/components/model-picker";
import { fetchImageModels } from "@/services/api/image";
import { fetchUserConfig, measureUserStorageProvider, syncUserModelConfig, syncUserStorageProvider } from "@/services/api/user-config";
import { clearStorageConfigCache as clearFileStorageCache } from "@/services/file-storage";
import { clearStorageConfigCache as clearImageStorageCache, defaultUserStorageProvider, defaultUserWebDAVStorageProvider, loadStorageConfig, loadUserS3StorageProvider, loadUserWebDAVStorageProvider, saveUserStorageProvider, saveUserWebDAVStorageProvider, type UserStorageProvider } from "@/services/image-storage";
import { audioFormatOptions, audioVoiceOptions, glmTtsFormatOptions, glmTtsVoiceOptions, isGlmTtsModel, normalizeAudioSpeedValue, normalizeGlmTtsFormat, normalizeGlmTtsSpeed, normalizeGlmTtsVoice } from "@/lib/audio-generation";
import { isMimoPresetTtsModel, isMimoTtsModel, isMimoVoiceCloneModel, isMimoVoiceDesignModel, mimoTtsFormatOptions, mimoTtsVoiceOptions } from "@/lib/mimo-tts";
import { filterModelsByCapability, normalizeLocalChannels, useConfigStore, useEffectiveConfig, type AiConfig, type LocalModelChannel, type ModelCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    channelKey: "imageChannelId" | "videoChannelId" | "textChannelId" | "audioChannelId";
    modelsKey: "imageModels" | "videoModels" | "textModels" | "audioModels";
    defaultLabel: string;
    optionsLabel: string;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", channelKey: "imageChannelId", modelsKey: "imageModels", defaultLabel: "默认生图模型", optionsLabel: "生图模型可选项" },
    { capability: "video", modelKey: "videoModel", channelKey: "videoChannelId", modelsKey: "videoModels", defaultLabel: "默认视频模型", optionsLabel: "视频模型可选项" },
    { capability: "text", modelKey: "textModel", channelKey: "textChannelId", modelsKey: "textModels", defaultLabel: "默认文本模型", optionsLabel: "文本模型可选项" },
    { capability: "audio", modelKey: "audioModel", channelKey: "audioChannelId", modelsKey: "audioModels", defaultLabel: "默认音频模型", optionsLabel: "音频模型可选项" },
];

export function AppConfigModal() {
    const { message } = App.useApp();
    const [loadingModels, setLoadingModels] = useState(false);
    const [savingConfig, setSavingConfig] = useState(false);
    const [remoteStorageSyncEnabled, setRemoteStorageSyncEnabled] = useState(false);
    const [remoteWebDAVStorageSyncEnabled, setRemoteWebDAVStorageSyncEnabled] = useState(false);
    const [allowUserStorageProvider, setAllowUserStorageProvider] = useState(false);
    const [userStorage, setUserStorage] = useState(() => defaultUserStorageProvider());
    const [userWebDAVStorage, setUserWebDAVStorage] = useState(() => defaultUserWebDAVStorageProvider());
    const [measuringStorageType, setMeasuringStorageType] = useState<"s3" | "webdav" | null>(null);
    const [storageUsageText, setStorageUsageText] = useState("");
    const [webDAVStorageUsageText, setWebDAVStorageUsageText] = useState("");
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const effectiveConfig = useEffectiveConfig();
    const modelChannel = publicSettings?.modelChannel;
    const isLoggedIn = Boolean(token && user);
    const canUseRemoteChannel = isLoggedIn && (user?.role === "admin" || modelChannel?.allowUserRemoteChannel === true);
    const allowCustomChannel = isLoggedIn && modelChannel?.allowCustomChannel === true;
    const effectiveMode = canUseRemoteChannel ? (allowCustomChannel ? config.channelMode : "remote") : "local";
    const localModelConfig: AiConfig = effectiveMode === "local" && config.channelMode !== "local" ? { ...config, channelMode: "local" } : config;
    const modelConfig = effectiveMode === "remote" ? effectiveConfig : localModelConfig;
    const canUseUserStorageProvider = isLoggedIn && allowUserStorageProvider;
    const glmTts = isGlmTtsModel(config.audioModel);

    useEffect(() => {
        setUserStorage(loadUserS3StorageProvider() || defaultUserStorageProvider());
        setUserWebDAVStorage(loadUserWebDAVStorageProvider() || defaultUserWebDAVStorageProvider());
        if (!isConfigOpen || !token) return;
        let canceled = false;
        void fetchUserConfig(token)
            .then((payload) => {
                if (canceled) return;
                const remoteConfig = payload.modelConfig;
                const syncS3 = remoteConfig?.syncStorageConfig === true;
                const syncWebDAV = remoteConfig?.syncWebDAVStorageConfig === true;
                setRemoteStorageSyncEnabled(syncS3);
                setRemoteWebDAVStorageSyncEnabled(syncWebDAV);
                if (remoteConfig) {
                    Object.entries(remoteConfig)
                        .forEach(([key, value]) => updateConfig(key as keyof AiConfig, value as never));
                }
                updateConfig("syncStorageConfig", syncS3);
                updateConfig("syncWebDAVStorageConfig", syncWebDAV);
                if (syncS3 && payload.storageProvider?.s3) {
                    const next = { ...defaultUserStorageProvider(), ...payload.storageProvider.s3, type: "s3" as const };
                    setUserStorage(next);
                    saveUserStorageProvider(next);
                }
                if (syncWebDAV && payload.storageProvider?.webdav) {
                    const next = { ...defaultUserWebDAVStorageProvider(), ...payload.storageProvider.webdav, type: "webdav" as const };
                    setUserWebDAVStorage(next);
                    saveUserWebDAVStorageProvider(next);
                }
            })
            .catch(() => { });
        return () => {
            canceled = true;
        };
    }, [isConfigOpen, token, updateConfig]);

    useEffect(() => {
        if (!isConfigOpen) return;
        let canceled = false;
        void loadStorageConfig()
            .then((storage) => {
                if (!canceled) setAllowUserStorageProvider(storage.allowUserProvider === true);
            })
            .catch(() => {
                if (!canceled) setAllowUserStorageProvider(false);
            });
        return () => {
            canceled = true;
        };
    }, [isConfigOpen]);

    const finishConfig = async () => {
        const localIncomplete = effectiveMode === "local" && normalizeLocalChannels(config).some((channel) => !channel.baseUrl.trim() || !channel.apiKey.trim());
        const modelIncomplete = !modelConfig.imageModel.trim() || !modelConfig.videoModel.trim() || !modelConfig.textModel.trim();
        if (userStorage.enabled && userWebDAVStorage.enabled) {
            message.error("S3/R2 与 WebDAV 不能同时启用");
            return;
        }
        if (!canUseRemoteChannel && config.channelMode !== "local") updateConfig("channelMode", "local");
        else if (canUseRemoteChannel && !allowCustomChannel && config.channelMode !== "remote") updateConfig("channelMode", "remote");
        if (canUseUserStorageProvider) {
            saveUserStorageProvider(userStorage);
            saveUserWebDAVStorageProvider(userWebDAVStorage);
        }
        setSavingConfig(true);
        try {
            if (token) {
                const configToSave = effectiveMode === "local" && config.channelMode !== "local" ? { ...config, channelMode: "local" as const } : config;
                await syncUserModelConfig(token, configToSave);
            }
            const providers = {
                ...(config.syncStorageConfig || remoteStorageSyncEnabled ? { s3: config.syncStorageConfig ? userStorage : { ...userStorage, enabled: false, endpoint: "", bucket: "", accessKeyId: "", secretAccessKey: "" } } : {}),
                ...(config.syncWebDAVStorageConfig || remoteWebDAVStorageSyncEnabled ? { webdav: config.syncWebDAVStorageConfig ? userWebDAVStorage : { ...userWebDAVStorage, enabled: false, endpoint: "", username: "", password: "" } } : {}),
            };
            if (token && canUseUserStorageProvider && Object.keys(providers).length) {
                await syncUserStorageProvider(token, providers);
                setRemoteStorageSyncEnabled(config.syncStorageConfig);
                setRemoteWebDAVStorageSyncEnabled(config.syncWebDAVStorageConfig);
            }
            clearImageStorageCache();
            clearFileStorageCache();
            setConfigDialogOpen(false);
            if ((config.syncStorageConfig || config.syncWebDAVStorageConfig) && !token) message.warning("请登录后再同步配置");
            else if (localIncomplete || modelIncomplete) message.warning("部分模型或本地渠道密钥尚未配置完整，配置已保存");
            else message.success(shouldPromptContinue ? "配置已保存，请继续刚才的请求" : "配置已保存");
            clearPromptContinue();
        } catch (error) {
            message.error(error instanceof Error ? "同步配置失败：" + error.message : "同步配置失败");
        } finally {
            setSavingConfig(false);
        }
    };

    const refreshModels = async () => {
        if (effectiveMode === "remote") return;
        const channels = normalizeLocalChannels(config);
        if (channels.some((channel) => !channel.baseUrl.trim() || !channel.apiKey.trim())) {
            message.error("请先填写所有本地渠道的 Base URL 和 API Key");
            return;
        }
        setLoadingModels(true);
        try {
            const nextChannels = await Promise.all(channels.map(async (channel) => ({ ...channel, models: await fetchImageModels(configForLocalChannel(config, channel)) })));
            updateLocalChannels(nextChannels);
            message.success("模型列表已更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingModels(false);
        }
    };

    const updateLocalChannels = (channels: LocalModelChannel[]) => {
        const normalized = channels.length ? channels : normalizeLocalChannels({ baseUrl: config.baseUrl, apiKey: config.apiKey, models: config.models });
        const models = uniqueModels(normalized.flatMap((channel) => channel.models));
        const nextImageModels = filterModelsByCapability(models, "image");
        const nextVideoModels = filterModelsByCapability(models, "video");
        const nextTextModels = filterModelsByCapability(models, "text");
        const nextAudioModels = filterModelsByCapability(models, "audio");
        const imageModel = nextImageModels.includes(config.imageModel) ? config.imageModel : nextImageModels[0] || "";
        const videoModel = nextVideoModels.includes(config.videoModel) ? config.videoModel : nextVideoModels[0] || "";
        const textModel = nextTextModels.includes(config.textModel) ? config.textModel : nextTextModels[0] || "";
        const audioModel = nextAudioModels.includes(config.audioModel) ? config.audioModel : nextAudioModels[0] || "";
        updateConfig("localChannels", normalized);
        updateConfig("models", models);
        updateConfig("imageModels", nextImageModels);
        updateConfig("videoModels", nextVideoModels);
        updateConfig("textModels", nextTextModels);
        updateConfig("audioModels", nextAudioModels);
        updateConfig("imageModel", imageModel);
        updateConfig("videoModel", videoModel);
        updateConfig("textModel", textModel);
        updateConfig("audioModel", audioModel);
        updateConfig("imageChannelId", channelIdForLocalModel(normalized, imageModel, config.imageChannelId));
        updateConfig("videoChannelId", channelIdForLocalModel(normalized, videoModel, config.videoChannelId));
        updateConfig("textChannelId", channelIdForLocalModel(normalized, textModel, config.textChannelId));
        updateConfig("audioChannelId", channelIdForLocalModel(normalized, audioModel, config.audioChannelId));
        updateConfig("baseUrl", normalized[0]?.baseUrl || config.baseUrl);
        updateConfig("apiKey", normalized[0]?.apiKey || config.apiKey);
    };

    const patchLocalChannel = (id: string, patch: Partial<LocalModelChannel>) => {
        updateLocalChannels(normalizeLocalChannels(config).map((channel) => (channel.id === id ? { ...channel, ...patch } : channel)));
    };

    const addLocalChannel = () => {
        updateLocalChannels([...normalizeLocalChannels(config), { id: "local-" + Date.now(), protocol: "openai", name: "新渠道", baseUrl: "", apiKey: "", models: [] }]);
    };

    const removeLocalChannel = (id: string) => {
        updateLocalChannels(normalizeLocalChannels(config).filter((channel) => channel.id !== id));
    };

    const refreshLocalChannelModels = async (channel: LocalModelChannel) => {
        if (!channel.baseUrl.trim() || !channel.apiKey.trim()) {
            message.error("请先填写该渠道的 Base URL 和 API Key");
            return;
        }
        setLoadingModels(true);
        try {
            patchLocalChannel(channel.id, { models: await fetchImageModels(configForLocalChannel(config, channel)) });
            message.success("模型列表已更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingModels(false);
        }
    };


    const measureStorage = async (provider: UserStorageProvider) => {
        if (!token) {
            message.warning("请先登录后再统计容量");
            return;
        }
        setMeasuringStorageType(provider.type);
        try {
            const result = await measureUserStorageProvider(token, provider);
            const usageText = formatBytes(result.bytes) + " / " + formatBytes(result.limitBytes) + (result.overLimit ? "，已达到上限" : "");
            if (provider.type === "webdav") {
                setWebDAVStorageUsageText(usageText);
                if (result.overLimit) {
                    const next = { ...userWebDAVStorage, enabled: false };
                    setUserWebDAVStorage(next);
                    saveUserWebDAVStorageProvider(next);
                }
            } else {
                setStorageUsageText(usageText);
                if (result.overLimit) {
                    const next = { ...userStorage, enabled: false };
                    setUserStorage(next);
                    saveUserStorageProvider(next);
                }
            }
            message.success("容量统计完成");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "容量统计失败");
        } finally {
            setMeasuringStorageType(null);
        }
    };

    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">配置与用户偏好</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">模型、渠道和画布默认行为</div>
                </div>
            }
            open={isConfigOpen}
            width={960}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 18 } }}
            footer={
                <Button type="primary" loading={savingConfig} onClick={() => void finishConfig()}>
                    完成
                </Button>
            }
        >
            <div className="pt-1">
                <Form layout="vertical" requiredMark={false}>
                    {allowCustomChannel && canUseRemoteChannel ? (
                        <Form.Item label="渠道模式" className="mb-5">
                            <Segmented
                                block
                                size="middle"
                                value={effectiveMode}
                                onChange={(value) => updateConfig("channelMode", value as AiConfig["channelMode"])}
                                options={[
                                    { label: "本地直连", value: "local" },
                                    { label: "云端渠道", value: "remote" },
                                ]}
                            />
                        </Form.Item>
                    ) : null}
                    {effectiveMode === "local" ? (
                        <>
                            <div className="mb-5 space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium">本地模型渠道</div>
                                        <div className="mt-1 text-xs text-stone-500">可为生图、视频、文本、音频分别选择不同渠道的模型。</div>
                                    </div>
                                    <Button size="small" onClick={addLocalChannel}>
                                        新增渠道
                                    </Button>
                                </div>
                                {normalizeLocalChannels(config).map((channel, index) => (
                                    <div key={channel.id} className="space-y-2 rounded-md bg-stone-50 p-2 dark:bg-stone-900">
                                        <div className="grid gap-2 md:grid-cols-[130px_150px_minmax(0,1fr)_minmax(0,1fr)_auto]">
                                            <Input value={channel.name} placeholder="渠道名称" onChange={(event) => patchLocalChannel(channel.id, { name: event.target.value })} />
                                            <Select
                                                value={channel.protocol}
                                                options={[
                                                    { label: "OpenAI", value: "openai" },
                                                    { label: "KIE", value: "kie" },
                                                    { label: "MiMo", value: "mimo" },
                                                ]}
                                                onChange={(protocol) => patchLocalChannel(channel.id, { protocol: protocol as LocalModelChannel["protocol"] })}
                                            />
                                            <Input value={channel.baseUrl} placeholder="Base URL" onChange={(event) => patchLocalChannel(channel.id, { baseUrl: event.target.value })} />
                                            <Input.Password value={channel.apiKey} placeholder="API Key" onChange={(event) => patchLocalChannel(channel.id, { apiKey: event.target.value })} />
                                            <div className="flex gap-2">
                                                <Button size="small" loading={loadingModels} onClick={() => void refreshLocalChannelModels(channel)}>
                                                    拉取
                                                </Button>
                                                <Button size="small" danger disabled={index === 0 && normalizeLocalChannels(config).length === 1} onClick={() => removeLocalChannel(channel.id)}>
                                                    删除
                                                </Button>
                                            </div>
                                        </div>
                                        <div className="text-xs text-stone-500">已保存 {channel.models.length} 个模型</div>
                                    </div>
                                ))}
                            </div>
                            <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">模型列表</div>
                                    <div className="mt-1 text-xs text-stone-500">当前已保存 {config.models.length} 个模型</div>
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                    <Button size="small" loading={loadingModels} onClick={() => void refreshModels()}>
                                        拉取全部渠道
                                    </Button>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="mb-5 rounded-lg border border-stone-200 p-3 text-sm text-stone-500 dark:border-stone-800">
                            <div className="font-medium text-stone-900 dark:text-stone-100">云端渠道</div>
                            <div className="mt-1">由系统后台渠道转发请求，当前可用 {modelChannel?.availableModels.length || 0} 个模型。</div>
                        </div>
                    )}
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                        {modelGroups.map((group) => (
                            <Form.Item key={group.modelKey} label={group.defaultLabel} className="mb-4">
                                <ModelPicker config={modelConfig} value={modelConfig[group.modelKey]} channelId={modelConfig[group.channelKey]} onChange={(model, channelId) => { updateConfig(group.modelKey, model); if (channelId) updateConfig(group.channelKey, channelId); }} capability={group.capability} fullWidth />
                            </Form.Item>
                        ))}
                    </div>
                    <div className="grid gap-4 md:grid-cols-4">
                        <Form.Item label="画布默认生图张数" extra="新建画布生图和配置节点默认使用，单个节点仍可单独覆盖。" className="mb-4">
                            <Input
                                type="number"
                                min={1}
                                max={15}
                                value={config.canvasImageCount}
                                onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                            />
                        </Form.Item>
                        {isMimoPresetTtsModel(config.audioModel) ? (
                            <Form.Item label="默认 MiMo 音色" className="mb-4">
                                <Select value={config.mimoTtsVoice} options={[...mimoTtsVoiceOptions]} onChange={(value) => updateConfig("mimoTtsVoice", value)} />
                            </Form.Item>
                        ) : isMimoVoiceDesignModel(config.audioModel) ? (
                            <Form.Item label="默认音色描述" className="mb-4">
                                <Input value={config.mimoVoiceDesignPrompt} placeholder="例如：年轻女性，声音清亮自然，有亲和力。" onChange={(event) => updateConfig("mimoVoiceDesignPrompt", event.target.value)} />
                            </Form.Item>
                        ) : isMimoTtsModel(config.audioModel) ? null : (
                            <Form.Item label="默认音频声音" className="mb-4">
                                <Select value={glmTts ? normalizeGlmTtsVoice(config.glmTtsVoice) : config.audioVoice} options={glmTts ? glmTtsVoiceOptions : audioVoiceOptions} onChange={(value) => updateConfig(glmTts ? "glmTtsVoice" : "audioVoice", value)} />
                            </Form.Item>
                        )}
                        <Form.Item label="默认音频格式" className="mb-4">
                            <Select value={isMimoTtsModel(config.audioModel) ? config.mimoTtsFormat : glmTts ? normalizeGlmTtsFormat(config.glmTtsFormat) : config.audioFormat} options={isMimoTtsModel(config.audioModel) ? [...mimoTtsFormatOptions] : glmTts ? glmTtsFormatOptions : audioFormatOptions} onChange={(value) => isMimoTtsModel(config.audioModel) ? updateConfig("mimoTtsFormat", value) : updateConfig(glmTts ? "glmTtsFormat" : "audioFormat", value)} />
                        </Form.Item>
                        {!isMimoTtsModel(config.audioModel) ? (
                            <Form.Item label="默认音频语速" className="mb-4">
                                <Input
                                    type="number"
                                    min={glmTts ? 0.5 : 0.25}
                                    max={glmTts ? 2 : 4}
                                    step={0.05}
                                    value={glmTts ? config.glmTtsSpeed : config.audioSpeed}
                                    onChange={(event) => updateConfig(glmTts ? "glmTtsSpeed" : "audioSpeed", event.target.value)}
                                    onBlur={(event) => updateConfig(glmTts ? "glmTtsSpeed" : "audioSpeed", glmTts ? normalizeGlmTtsSpeed(event.target.value) : normalizeAudioSpeedValue(event.target.value))}
                                />
                            </Form.Item>
                        ) : null}
                    </div>
                    <div className="mb-4 grid gap-3 md:grid-cols-3">
                        <FeatureSwitch title="流式传输" description="开启后请求中追加 stream，支持读取中间图片事件并避免长时间无数据。" checked={Boolean(config.streamImages)} onChange={(checked) => updateConfig("streamImages", checked ? "1" : "")} />
                        <FeatureSwitch title="返回 Base64 图片数据" description="开启后 Image API 请求会追加 response_format: b64_json。" checked={Boolean(config.responseFormatB64Json)} onChange={(checked) => updateConfig("responseFormatB64Json", checked ? "1" : "")} />
                        <FeatureSwitch title="Codex CLI 兼容模式" description="开启后减少不兼容参数，并追加防提示词改写前缀。" checked={Boolean(config.codexCli)} onChange={(checked) => updateConfig("codexCli", checked ? "1" : "")} />
                    </div>
                    {canUseUserStorageProvider ? (
                        <>
                            <section className="mb-5 mt-4 rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/50">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium">用户 S3/R2 存储</div>
                                        <div className="mt-1 text-xs text-stone-500">
                                            开启后，新生成图片和媒体文件会优先保存到你的 S3 兼容对象存储。
                                            {storageUsageText ? <>当前容量：{storageUsageText}</> : null}
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                        <Button size="small" loading={measuringStorageType === "s3"} onClick={() => void measureStorage(userStorage)}>
                                            统计容量
                                        </Button>
                                        <span className="text-xs text-stone-500">自动同步</span>
                                        <Switch size="small" checked={config.syncStorageConfig} onChange={(checked) => updateConfig("syncStorageConfig", checked)} />
                                        <Switch checked={userStorage.enabled} disabled={userWebDAVStorage.enabled} onChange={(enabled) => setUserStorage((value) => ({ ...value, enabled }))} />
                                    </div>
                                </div>
                                {userStorage.enabled ? (
                                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                                        <Input value={userStorage.name} placeholder="配置名称" onChange={(event) => setUserStorage((value) => ({ ...value, name: event.target.value }))} />
                                        <Input value={userStorage.endpoint} placeholder="Endpoint，例如 https://<account>.r2.cloudflarestorage.com" onChange={(event) => setUserStorage((value) => ({ ...value, endpoint: event.target.value }))} />
                                        <Input value={userStorage.region} placeholder="Region，R2 通常为 auto" onChange={(event) => setUserStorage((value) => ({ ...value, region: event.target.value }))} />
                                        <Input value={userStorage.bucket} placeholder="Bucket 名称" onChange={(event) => setUserStorage((value) => ({ ...value, bucket: event.target.value }))} />
                                        <Input value={userStorage.accessKeyId} placeholder="Access Key ID" onChange={(event) => setUserStorage((value) => ({ ...value, accessKeyId: event.target.value }))} />
                                        <Input.Password value={userStorage.secretAccessKey} placeholder="Secret Access Key" onChange={(event) => setUserStorage((value) => ({ ...value, secretAccessKey: event.target.value }))} />
                                        <Input value={userStorage.publicBaseUrl} placeholder="公开访问地址，例如 https://pub-xxx.r2.dev" onChange={(event) => setUserStorage((value) => ({ ...value, publicBaseUrl: event.target.value }))} />
                                        <Input value={userStorage.pathPrefix} placeholder="保存路径前缀，例如 images" onChange={(event) => setUserStorage((value) => ({ ...value, pathPrefix: event.target.value }))} />
                                    </div>
                                ) : null}
                            </section>
                            <section className="mb-5 mt-4 rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/50">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium">WebDAV 存储</div>
                                        <div className="mt-1 text-xs text-stone-500">
                                            开启后，新生成图片和媒体文件会优先保存到你的 WebDAV。
                                            {webDAVStorageUsageText ? <>当前容量：{webDAVStorageUsageText}</> : null}
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                        <Button size="small" loading={measuringStorageType === "webdav"} onClick={() => void measureStorage(userWebDAVStorage)}>
                                            统计容量
                                        </Button>
                                        <span className="text-xs text-stone-500">自动同步</span>
                                        <Switch size="small" checked={config.syncWebDAVStorageConfig} onChange={(checked) => updateConfig("syncWebDAVStorageConfig", checked)} />
                                        <Switch checked={userWebDAVStorage.enabled} disabled={userStorage.enabled} onChange={(enabled) => setUserWebDAVStorage((value) => ({ ...value, enabled }))} />
                                    </div>
                                </div>
                                {userWebDAVStorage.enabled ? (
                                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                                        <Input value={userWebDAVStorage.name} placeholder="配置名称" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, name: event.target.value }))} />
                                        <Input value={userWebDAVStorage.endpoint} placeholder="WebDAV 地址" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, endpoint: event.target.value }))} />
                                        <Input value={userWebDAVStorage.pathPrefix} placeholder="远程目录" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, pathPrefix: event.target.value }))} />
                                        <Input value={userWebDAVStorage.username} placeholder="用户名" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, username: event.target.value }))} />
                                        <Input.Password value={userWebDAVStorage.password} placeholder="密码 / 应用密码" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, password: event.target.value }))} />
                                    </div>
                                ) : null}
                            </section>
                        </>
                    ) : null}
                    {(!isMimoTtsModel(config.audioModel) || isMimoPresetTtsModel(config.audioModel) || isMimoVoiceCloneModel(config.audioModel)) && !glmTts ? (
                        <Form.Item label="默认音频指令" className="mb-4">
                            <Input.TextArea rows={2} value={config.audioInstructions} placeholder="例如：自然、温暖、适合旁白。" onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                        </Form.Item>
                    ) : null}
                    {effectiveMode === "local" ? (
                        <Form.Item label="系统提示词" className="mb-0">
                            <Input.TextArea rows={3} value={config.systemPrompt} placeholder="例如：你是一位擅长电影感写实摄影的视觉导演。" onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                        </Form.Item>
                    ) : null}
                </Form>
            </div>
        </Modal>
    );
}

function FeatureSwitch({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <div className="rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
            <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{title}</div>
                <Switch checked={checked} onChange={onChange} />
            </div>
            <div className="mt-1 text-xs leading-5 text-stone-500">{description}</div>
        </div>
    );
}

function configForLocalChannel(config: AiConfig, channel: LocalModelChannel): AiConfig {
    return {
        ...config,
        channelMode: "local",
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        localChannels: [{ ...channel }],
        imageChannelId: channel.id,
        videoChannelId: channel.id,
        textChannelId: channel.id,
        audioChannelId: channel.id,
        model: channel.models[0] || config.model,
    };
}

function channelIdForLocalModel(channels: LocalModelChannel[], model: string, currentId: string) {
    if (!channels.length) return "";
    if (channels.some((channel) => channel.id === currentId && (!model || channel.models.includes(model)))) return currentId;
    return channels.find((channel) => model && channel.models.includes(model))?.id || channels[0].id;
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}


function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
