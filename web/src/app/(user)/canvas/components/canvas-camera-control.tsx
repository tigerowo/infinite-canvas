"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Camera, ChevronDown, ChevronUp, X } from "lucide-react";
import { Button, Switch, Tooltip } from "antd";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import {
    APERTURES,
    APERTURE_META,
    CAMERA_PROFILES,
    FOCAL_LENGTHS,
    FOCAL_LENGTH_META,
    LENS_PROFILES,
    type CameraProfile,
    type LensProfile,
} from "../utils/canvas-camera";
import type { CameraControlOptions } from "../types";

type CanvasCameraControlProps = {
    value?: CameraControlOptions;
    onChange: (value: CameraControlOptions) => void;
    buttonClassName?: string;
};

const DEFAULT_CAMERA_CONTROL: CameraControlOptions = {
    enabled: false,
    camera: CAMERA_PROFILES[0].id,
    lens: LENS_PROFILES[0].id,
    focalLength: 50,
    aperture: 4,
};

const CAMERA_IDS = CAMERA_PROFILES.map((item) => item.id);
const LENS_IDS = LENS_PROFILES.map((item) => item.id);

export function CanvasCameraControl({ value, onChange, buttonClassName }: CanvasCameraControlProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const cameraControl = value || DEFAULT_CAMERA_CONTROL;
    const camera = CAMERA_PROFILES.find((item) => item.id === cameraControl.camera) || CAMERA_PROFILES[0];
    const lens = LENS_PROFILES.find((item) => item.id === cameraControl.lens) || LENS_PROFILES[0];
    const focalMeta = FOCAL_LENGTH_META[cameraControl.focalLength];
    const apertureMeta = APERTURE_META[cameraControl.aperture];
    const updateCameraControl = (patch: Partial<CameraControlOptions>) => onChange({ ...cameraControl, ...patch });

    useEffect(() => {
        if (!open) return;

        const trigger = buttonRef.current;
        const node = trigger?.closest<HTMLElement>("[data-node-id]");
        const canvasLayer = node?.parentElement;
        if (!trigger || !node || !canvasLayer) return;

        const syncPosition = () => {
            const next = trigger.getBoundingClientRect();
            setButtonRect((current) =>
                current &&
                current.left === next.left &&
                current.top === next.top &&
                current.width === next.width &&
                current.height === next.height
                    ? current
                    : next,
            );
        };

        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node) || buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };

        const observer = new MutationObserver(syncPosition);
        observer.observe(node, { attributes: true, attributeFilter: ["style"] });
        observer.observe(canvasLayer, { attributes: true, attributeFilter: ["style"] });

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);

        return () => {
            observer.disconnect();
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const panelStyle = buttonRect
        ? {
            position: "fixed",
            zIndex: 1200,
            width: 900,
            left: buttonRect.left + buttonRect.width / 2,
            bottom: window.innerHeight - buttonRect.top + 8,
            transform: "translateX(-50%) scale(0.75)",
            transformOrigin: "center bottom",
            overflowY: "auto",
            background: theme.toolbar.panel,
            border: "1px solid " + theme.toolbar.border,
            borderRadius: 18,
            boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
            color: theme.node.text,
        } as const
        : undefined;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <Button
                    icon={<Camera className="size-4" />}
                    className={buttonClassName || "!h-10 !min-w-[92px] !justify-start !rounded-full !px-3"}
                    style={{
                        background: value?.enabled ? theme.toolbar.activeBg : theme.node.fill,
                        borderColor: value?.enabled ? theme.node.activeStroke : theme.node.stroke,
                        color: value?.enabled ? theme.toolbar.activeText : theme.node.text,
                    }}
                    aria-expanded={open}
                    onClick={() => setOpen((current) => !current)}
                >
                    摄像机
                </Button>
            </span>

            {open && buttonRect && panelStyle
                ? createPortal(
                      <div
                          ref={panelRef}
                          style={panelStyle}
                          onPointerDown={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                          onWheel={(event) => event.stopPropagation()}
                      >
                          <div className="flex items-center justify-between border-b px-6 py-4" style={{ borderColor: theme.toolbar.border }}>
                              <h2 className="text-base font-semibold">摄像机</h2>
                              <button type="button" className="grid size-8 place-items-center rounded-lg transition hover:opacity-70" style={{ color: theme.node.muted }} aria-label="关闭" onClick={() => setOpen(false)}>
                                  <X className="size-5" />
                              </button>
                          </div>

                          <div className="px-6 py-5">
                              <div className="overflow-x-auto">
                                  <div className="grid min-w-[840px] grid-cols-4">
                                      <SettingColumn
                                          theme={theme}
                                          label="相机"
                                          tooltipTitle={camera.zhName + " · " + camera.label}
                                          tooltipDesc={camera.description}
                                          tooltipUseCase={camera.useCase}
                                          visual={<CameraVisual profile={camera} theme={theme} />}
                                          caption={camera.label}
                                          onPrevious={cameraControl.camera === CAMERA_IDS[0] ? undefined : () => updateCameraControl({ camera: cycleValue(CAMERA_IDS, cameraControl.camera, -1) })}
                                          onNext={cameraControl.camera === CAMERA_IDS[CAMERA_IDS.length - 1] ? undefined : () => updateCameraControl({ camera: cycleValue(CAMERA_IDS, cameraControl.camera, 1) })}
                                      />
                                      <SettingColumn
                                          theme={theme}
                                          separator
                                          label="镜头"
                                          tooltipTitle={lens.zhName + " · " + lens.label}
                                          tooltipDesc={lens.description}
                                          tooltipUseCase={lens.useCase}
                                          visual={<LensVisual profile={lens} theme={theme} />}
                                          caption={lens.label}
                                          onPrevious={cameraControl.lens === LENS_IDS[0] ? undefined : () => updateCameraControl({ lens: cycleValue(LENS_IDS, cameraControl.lens, -1) })}
                                          onNext={cameraControl.lens === LENS_IDS[LENS_IDS.length - 1] ? undefined : () => updateCameraControl({ lens: cycleValue(LENS_IDS, cameraControl.lens, 1) })}
                                      />
                                      <SettingColumn
                                          theme={theme}
                                          separator
                                          label="焦距"
                                          tooltipTitle={cameraControl.focalLength + "mm · " + (focalMeta?.zhName || "")}
                                          tooltipDesc={focalMeta?.description}
                                          tooltipUseCase={focalMeta?.useCase}
                                          badge={focalMeta?.zhName}
                                          visual={
                                              <div className="flex flex-col items-center">
                                                  <div className="text-5xl font-light leading-none" style={{ color: theme.node.text }}>{cameraControl.focalLength}</div>
                                                  <div className="mt-2 text-xs tracking-wider" style={{ color: theme.node.faint }}>mm</div>
                                              </div>
                                          }
                                          caption="mm"
                                          onPrevious={cameraControl.focalLength === FOCAL_LENGTHS[0] ? undefined : () => updateCameraControl({ focalLength: cycleValue(FOCAL_LENGTHS, cameraControl.focalLength, -1) })}
                                          onNext={cameraControl.focalLength === FOCAL_LENGTHS[FOCAL_LENGTHS.length - 1] ? undefined : () => updateCameraControl({ focalLength: cycleValue(FOCAL_LENGTHS, cameraControl.focalLength, 1) })}
                                      />
                                      <SettingColumn
                                          theme={theme}
                                          separator
                                          label="光圈"
                                          tooltipTitle={"f/" + cameraControl.aperture + " · " + (apertureMeta?.zhName || "")}
                                          tooltipDesc={apertureMeta?.description}
                                          tooltipUseCase={apertureMeta?.useCase}
                                          badge={apertureMeta?.zhName}
                                          visual={
                                              <div className="flex items-baseline">
                                                  <span className="text-2xl font-light" style={{ color: theme.node.muted }}>f/</span>
                                                  <span className="text-5xl font-light leading-none" style={{ color: theme.node.text }}>{cameraControl.aperture}</span>
                                              </div>
                                          }
                                          caption={"f/" + cameraControl.aperture}
                                          onPrevious={cameraControl.aperture === APERTURES[0] ? undefined : () => updateCameraControl({ aperture: cycleValue(APERTURES, cameraControl.aperture, -1) })}
                                          onNext={cameraControl.aperture === APERTURES[APERTURES.length - 1] ? undefined : () => updateCameraControl({ aperture: cycleValue(APERTURES, cameraControl.aperture, 1) })}
                                      />
                                  </div>
                              </div>

                              <div className="mt-6 flex items-center justify-end gap-2">
                                  <span className="text-sm" style={{ color: cameraControl.enabled ? theme.node.text : theme.node.muted }}>{cameraControl.enabled ? "开启" : "关闭"}</span>
                                  <Switch size="small" checked={cameraControl.enabled} aria-label="摄像机控制" onChange={(enabled) => updateCameraControl({ enabled })} />
                              </div>
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}

type SettingColumnProps = {
    theme: CanvasTheme;
    separator?: boolean;
    label: string;
    tooltipTitle: string;
    tooltipDesc?: string;
    tooltipUseCase?: string;
    badge?: ReactNode;
    visual: ReactNode;
    caption: string;
    onPrevious?: () => void;
    onNext?: () => void;
};

function SettingColumn({ theme, separator, label, tooltipTitle, tooltipDesc, tooltipUseCase, badge, visual, caption, onPrevious, onNext }: SettingColumnProps) {
    const tooltip = (
        <div className="max-w-64">
            <div className="font-medium">{tooltipTitle}</div>
            {tooltipDesc ? <div className="mt-1 text-xs opacity-80">{tooltipDesc}</div> : null}
            {tooltipUseCase ? <div className="mt-2 text-xs opacity-70">使用场景：{tooltipUseCase}</div> : null}
        </div>
    );

    return (
        <div className="flex flex-col items-center px-5" style={{ borderLeft: separator ? "1px solid " + theme.node.stroke : undefined }}>
            <Button type="text" disabled={!onPrevious} className="group !h-8 !w-full !p-0 hover:!bg-transparent" style={{ color: theme.node.faint }} icon={<ChevronUp className="h-5 w-8 rounded-md p-0.5 transition-colors group-hover:bg-foreground/5 group-hover:text-foreground/80" />} aria-label={"上一项" + label} onClick={onPrevious} />
            <Tooltip title={tooltip} mouseEnterDelay={0.7} color={theme.node.panel} zIndex={1300}>
                <div className="relative flex h-[180px] w-full max-w-[180px] cursor-help flex-col items-center justify-between rounded-2xl border px-4 py-3 transition-colors" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
                    <span className="text-sm font-medium" style={{ color: theme.node.muted }}>{label}</span>
                    <div className="flex flex-1 items-center justify-center">{visual}</div>
                    {badge ? <span className="absolute right-2 top-2.5 rounded-md px-2 py-0.5 text-xs font-medium" style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}>{badge}</span> : null}
                </div>
            </Tooltip>
            <Button type="text" disabled={!onNext} className="group !h-8 !w-full !p-0 hover:!bg-transparent" style={{ color: theme.node.faint }} icon={<ChevronDown className="h-5 w-8 rounded-md p-0.5 transition-colors group-hover:bg-foreground/5 group-hover:text-foreground/80" />} aria-label={"下一项" + label} onClick={onNext} />
            <span className="max-w-full truncate text-center text-sm" style={{ color: theme.node.muted }}>{caption}</span>
        </div>
    );
}

function CameraVisual({ profile, theme }: { profile: CameraProfile; theme: CanvasTheme }) {
    const body = profile.bodyColor;
    const accent = profile.accentColor;
    const dark = theme.canvas.background;
    const detail = theme.node.panel;
    const text = theme.node.muted;
    const svg = (children: ReactNode) => <svg viewBox="0 0 72 52" className="h-20 w-full" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">{children}</svg>;

    switch (profile.id) {
        case "panavision_dxl2":
            return svg(<><rect x="18" y="8" width="30" height="32" rx="3" fill={body} stroke={accent} /><rect x="10" y="12" width="12" height="24" rx="2" fill={detail} stroke={accent} /><rect x="48" y="14" width="16" height="20" rx="2" fill={detail} stroke={accent} /><circle cx="56" cy="24" r="6" fill={dark} stroke={accent} /><rect x="26" y="3" width="14" height="6" rx="1" fill={body} /><rect x="20" y="42" width="26" height="4" rx="1" fill={accent} opacity="0.6" /></>);
        case "arri_alexa_mini_lf":
            return svg(<><rect x="14" y="12" width="38" height="28" rx="4" fill={body} stroke={accent} /><circle cx="52" cy="26" r="10" fill={dark} stroke={accent} /><circle cx="52" cy="26" r="6" fill={detail} stroke={text} /><rect x="20" y="6" width="18" height="8" rx="1.5" fill={body} /><rect x="18" y="18" width="8" height="6" rx="1" fill={accent} opacity="0.3" /></>);
        case "red_komodo_6k":
        case "red_v_raptor_8k": {
            const raptor = profile.id === "red_v_raptor_8k";
            return svg(<><rect x="18" y="14" width={raptor ? 32 : 28} height="26" rx="2" fill={body} stroke={accent} /><circle cx={raptor ? 50 : 46} cy="27" r="9" fill={dark} stroke={accent} /><circle cx={raptor ? 50 : 46} cy="27" r="5" fill={detail} stroke={text} /><rect x="20" y="8" width="8" height="7" rx="1" fill={accent} opacity="0.85" /><text x="22" y="36" fontSize="6" fill={text} fontWeight="bold">RED</text></>);
        }
        case "sony_venice_2":
        case "sony_fx6":
            return svg(<><rect x="14" y="14" width="36" height="26" rx="3" fill={body} stroke={accent} /><circle cx="52" cy="27" r="9" fill={dark} stroke={accent} /><rect x="16" y="18" width="6" height="6" rx="1" fill={accent} opacity="0.5" /><rect x="22" y="8" width="16" height="8" rx="1.5" fill={body} /><text x="22" y="36" fontSize="5.5" fill={text}>SONY</text></>);
        case "blackmagic_ursa_12k":
            return svg(<><rect x="16" y="12" width="32" height="28" rx="2" fill={body} stroke={accent} /><circle cx="50" cy="26" r="10" fill={dark} stroke={accent} /><circle cx="50" cy="26" r="6" fill={detail} stroke={text} /><rect x="24" y="5" width="12" height="8" rx="1" fill={body} /><text x="18" y="35" fontSize="5" fill={accent} fontWeight="bold">URSA</text></>);
        case "canon_c500_mk2":
            return svg(<><rect x="16" y="12" width="34" height="28" rx="3" fill={body} stroke={accent} /><circle cx="50" cy="26" r="9" fill={dark} stroke={accent} /><rect x="18" y="16" width="10" height="5" rx="1" fill={accent} opacity="0.7" /><text x="20" y="36" fontSize="5.5" fill={text}>Canon</text></>);
        default:
            return svg(<><rect x="16" y="14" width="36" height="26" rx="3" fill={body} stroke={accent} /><circle cx="52" cy="27" r="9" fill={dark} stroke={accent} /></>);
    }
}

function LensVisual({ profile, theme }: { profile: LensProfile; theme: CanvasTheme }) {
    const rings = profile.id.startsWith("anamorphic") ? 4 : 3;
    return (
        <svg viewBox="0 0 88 56" className="h-20 w-full" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="8" y="17" width="68" height="24" rx="5" fill={profile.lensColor} stroke={theme.node.faint} />
            {Array.from({ length: rings }).map((_, index) => <rect key={index} x={18 + index * 14} y="17" width="5" height="24" fill={profile.ringColor} opacity="0.65" />)}
            <circle cx="72" cy="29" r="10" fill={theme.canvas.background} stroke={profile.ringColor} strokeWidth="2" />
            <circle cx="72" cy="29" r="5" fill={theme.node.panel} stroke={theme.node.faint} />
            {profile.id.startsWith("anamorphic") ? <ellipse cx="72" cy="29" rx="10" ry="4" fill="none" stroke={profile.ringColor} opacity="0.75" /> : null}
        </svg>
    );
}

function cycleValue<T>(values: readonly T[], value: T, direction: -1 | 1): T {
    const index = values.indexOf(value);
    return values[Math.min(Math.max(index + direction, 0), values.length - 1)];
}
