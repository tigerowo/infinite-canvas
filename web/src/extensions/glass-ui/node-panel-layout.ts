type Bounds = { left: number; right: number; top: number; bottom: number };

export function fitNodePanel(anchor: Bounds, area: Bounds, preferredWidth: number, contentHeight: number) {
    const margin = 12;
    const width = Math.max(0, Math.min(preferredWidth, area.right - area.left - margin * 2));
    const maxHeight = Math.max(0, area.bottom - area.top - margin * 2);
    const height = Math.min(contentHeight, maxHeight);
    const left = Math.max(area.left + margin, Math.min((anchor.left + anchor.right - width) / 2, area.right - margin - width));
    const below = anchor.bottom + 16;
    const above = anchor.top - height - 16;
    const preferredTop = below + height <= area.bottom - margin || above < area.top + margin ? below : above;
    const top = Math.max(area.top + margin, Math.min(preferredTop, area.bottom - margin - height));
    return { left, top, width, maxHeight, visible: width >= 240 && maxHeight >= 160 };
}
