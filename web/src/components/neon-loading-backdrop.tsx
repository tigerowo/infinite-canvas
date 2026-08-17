"use client";

import { motion } from "motion/react";

/**
 * 生成中霓虹流动背景层。
 * 铺满父容器,展示深空蓝黑底 + 冷色渐变流动 + 旋转辉光。
 * 画布节点、生图工作台、视频工作台生成中状态复用。
 * 使用 motion 驱动,不依赖 CSS keyframes。
 */
export function NeonLoadingBackdrop({ rounded = true }: { rounded?: boolean }) {
    return (
        <div className={`pointer-events-none absolute inset-0 z-0 overflow-hidden ${rounded ? "rounded-[inherit]" : ""}`}>
            {/* 底层:深空蓝黑底,让霓虹更通透 */}
            <div className="absolute inset-0" style={{ background: "linear-gradient(160deg, #05060f, #0b1026, #101a3a)" }} />
            {/* 主层:电光青→蓝→紫冷色渐变沿对角线流动 */}
            <motion.div
                className="absolute inset-0"
                style={{
                    backgroundImage: "linear-gradient(115deg, rgba(34,211,238,.9), rgba(59,130,246,.85), rgba(139,92,246,.8), rgba(34,211,238,.9))",
                    backgroundSize: "300% 300%",
                }}
                animate={{ backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"] }}
                transition={{ duration: 3.2, repeat: Infinity, ease: "linear" }}
            />
            {/* 辉光层:旋转的青色光晕增加流动感 */}
            <motion.div
                className="absolute -inset-[30%]"
                style={{
                    background: "conic-gradient(from 0deg, rgba(34,211,238,.4), transparent 25%, rgba(59,130,246,.35), transparent 55%, rgba(139,92,246,.35), transparent 85%)",
                    filter: "blur(24px)",
                }}
                animate={{ rotate: 360 }}
                transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
            />
            {/* 中心柔化,保证文字可读 */}
            <div className="absolute inset-0" style={{ background: "radial-gradient(circle at 50% 50%, rgba(0,0,0,.28), transparent 65%)" }} />
        </div>
    );
}
