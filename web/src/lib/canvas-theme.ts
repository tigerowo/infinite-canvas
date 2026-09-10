import { canvasThemes } from "@/extensions/glass-ui/canvas-colors";

export { canvasThemes };
export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";
export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
