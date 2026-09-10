export const canvasThemes = {
    light: {
        canvas: { background: "#ffffff", dot: "rgba(82,82,82,.20)", line: "rgba(82,82,82,.10)", selectionStroke: "#262626", selectionFill: "rgba(38,38,38,.06)" },
        node: { label: "#525252", fill: "#e5e5e5", panel: "#fafafa", stroke: "#d4d4d4", activeStroke: "#262626", placeholder: "#a3a3a3", text: "#262626", muted: "#737373", faint: "#a3a3a3" },
        toolbar: { panel: "rgba(250,250,250,.96)", border: "#d4d4d4", item: "#525252", itemHover: "#e5e5e5", activeBg: "#e5e5e5", activeText: "#262626" },
        glass: { panel: "rgba(250,250,250,.76)", border: "rgba(115,115,115,.22)", shadow: "0 18px 50px rgba(26,26,26,.12)", highlight: "rgba(255,255,255,.72)" },
    },
    dark: {
        canvas: { background: "#0a0a0a", dot: "rgba(245,245,245,.18)", line: "rgba(245,245,245,.08)", selectionStroke: "#fafafa", selectionFill: "rgba(250,250,250,.10)" },
        node: { label: "#d4d4d4", fill: "#262626", panel: "#1c1c1c", stroke: "#525252", activeStroke: "#fafafa", placeholder: "#a3a3a3", text: "#f5f5f5", muted: "#d4d4d4", faint: "#737373" },
        toolbar: { panel: "rgba(28,28,28,.96)", border: "#404040", item: "#d4d4d4", itemHover: "#262626", activeBg: "#363636", activeText: "#f5f5f5" },
        glass: { panel: "rgba(28,28,28,.76)", border: "rgba(212,212,212,.2)", shadow: "0 18px 50px rgba(0,0,0,.3)", highlight: "rgba(255,255,255,.1)" },
    },
} as const;
