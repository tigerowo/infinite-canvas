"use client";

import { type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { isKIESeedreamLayerDecompositionModel } from "@/lib/kie-models";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { SettingsPopover } from "@/extensions/glass-ui/settings-popover";
import styles from "@/extensions/glass-ui/glass-ui.module.css";
import { isNewAPIConfig } from "@/extensions/newapi/config";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
    showSize?: boolean;
    showCount?: boolean;
    buttonIcon?: ReactNode;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, buttonClassName, placement = "topLeft", showSize = true, showCount = true, buttonIcon }: CanvasImageSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const quality = config.quality || "auto";
    const chatImages = isNewAPIConfig(config) && config.apiMode === "chat";
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const layerDecomposition = isKIESeedreamLayerDecompositionModel(config.model);
    const effectiveShowSize = showSize && !layerDecomposition;
    const effectiveShowCount = showCount && !layerDecomposition;
    return (
        <SettingsPopover
            title="图像设置"
            placement={placement}
            onOpenChange={onOpenChange}
            trigger={
                <Button
                    size="small"
                    type="text"
                    className={buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"}
                    style={{ minHeight: 44, background: theme.glass.panel, color: theme.node.text, borderColor: theme.glass.border }}
                    icon={buttonIcon || <Settings2 className="size-3.5" />}
                >
                    <span className="truncate">
                        {chatImages ? (effectiveShowCount ? `${count} 张` : "图像设置") : effectiveShowSize ? (
                            <>
                                {imageQualityLabel(quality)} · {imageSizeLabel(activeSize)}
                                {effectiveShowCount ? <> · {count} 张</> : null}
                            </>
                        ) : (
                            <>
                                {imageQualityLabel(quality)}
                                {effectiveShowCount ? <> · {count} 张</> : null}
                            </>
                        )}
                    </span>
                </Button>
            }
        >
            <div className={styles.settings}>
                <ImageSettingsPanel config={config} onConfigChange={onConfigChange} theme={theme} className="space-y-4" showTitle={false} showSize={effectiveShowSize} showCount={effectiveShowCount} />
            </div>
        </SettingsPopover>
    );
}
