import type { CSSProperties } from "react";
import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";

const neutral = {
    light: {
        primary: "#171717",
        primaryHover: "#000000",
        primaryText: "#ffffff",
        info: "#00a1c2",
        menuBg: "#f5f5f5",
        menuText: "#171717",
        selectActiveBg: "#f5f5f5",
        selectSelectedBg: "#f0f0f0",
        selectText: "#171717",
        tableSelectedBg: "rgba(17, 17, 17, 0.05)",
        tableSelectedHoverBg: "rgba(17, 17, 17, 0.08)",
    },
    dark: {
        primary: "#fafafa",
        primaryHover: "#ffffff",
        primaryText: "#171717",
        info: "#00cae0",
        menuBg: "#262626",
        menuText: "#fafafa",
        selectActiveBg: "#262626",
        selectSelectedBg: "#333333",
        selectText: "#fafafa",
        tableSelectedBg: "rgba(255, 255, 255, 0.08)",
        tableSelectedHoverBg: "rgba(255, 255, 255, 0.12)",
    },
};

export const providerCenterTokens = {
    light: {
        accent: "#00a1c2",
        canvas: "#f8f9fa",
        surface: "#ffffff",
        surfaceMuted: "#f1f2f3",
        surfaceRaised: "#ffffff",
        text: "#0f1419",
        textSecondary: "rgba(15, 20, 25, 0.64)",
        textTertiary: "rgba(15, 20, 25, 0.48)",
        divider: "rgba(15, 20, 25, 0.12)",
    },
    dark: {
        accent: "#00cae0",
        canvas: "#0f0f12",
        surface: "#0e1416",
        surfaceMuted: "#161d1e",
        surfaceRaised: "#242b2c",
        text: "#f5fbff",
        textSecondary: "rgba(224, 245, 255, 0.60)",
        textTertiary: "rgba(224, 245, 255, 0.48)",
        divider: "rgba(224, 245, 255, 0.16)",
    },
} as const;

export function getProviderCenterThemeConfig(dark: boolean): ThemeConfig {
    const color = dark ? providerCenterTokens.dark : providerCenterTokens.light;

    return {
        token: {
            borderRadius: 8,
            colorBgContainer: color.surface,
            colorBgElevated: color.surfaceRaised,
            colorBorder: color.divider,
            colorError: "#ff3355",
            colorInfo: color.accent,
            colorText: color.text,
            colorTextSecondary: color.textSecondary,
            colorWarning: "#ffa21e",
            controlHeight: 40,
        },
        components: {
            Table: {
                borderColor: color.divider,
                cellPaddingBlockMD: 16,
                cellPaddingInlineMD: 24,
                headerBg: color.surfaceMuted,
                headerColor: color.textSecondary,
                headerSplitColor: color.divider,
                rowHoverBg: dark ? "#090f10" : color.canvas,
            },
            Tabs: {
                horizontalItemPadding: "8px 16px",
                inkBarColor: color.accent,
                itemActiveColor: color.accent,
                itemHoverColor: color.accent,
                itemSelectedColor: color.accent,
            },
        },
    };
}

export const adminLayoutStyle = {
    siderWidth: 232,
    headerHeight: 56,
    brandHeight: 64,
    menu: { borderInlineEnd: 0, padding: "18px 12px", fontSize: 15 } satisfies CSSProperties,
    menuItem: { height: 44, lineHeight: "44px", marginBlock: 4, borderRadius: 8 } satisfies CSSProperties,
};

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    const color = dark ? neutral.dark : neutral.light;

    return {
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: dark ? "infinite-canvas-dark" : "infinite-canvas-light" },
        token: {
            colorPrimary: color.primary,
            colorInfo: color.info,
            colorLink: color.primary,
            colorLinkHover: color.primaryHover,
            colorLinkActive: color.primary,
            colorTextLightSolid: color.primaryText,
        },
        components: {
            Button: {
                primaryShadow: "none",
            },
            Menu: {
                itemActiveBg: color.menuBg,
                itemHoverBg: color.menuBg,
                itemSelectedBg: color.menuBg,
                itemSelectedColor: color.menuText,
                darkItemHoverBg: neutral.dark.menuBg,
                darkItemSelectedBg: neutral.dark.menuBg,
                darkItemSelectedColor: neutral.dark.menuText,
            },
            Select: {
                optionActiveBg: color.selectActiveBg,
                optionSelectedBg: color.selectSelectedBg,
                optionSelectedColor: color.selectText,
            },
            Table: {
                rowSelectedBg: color.tableSelectedBg,
                rowSelectedHoverBg: color.tableSelectedHoverBg,
            },
        },
    };
}
