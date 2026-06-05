/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // —— 暖米白浅色主题（A 方案：Notion / Linear 风）——
        // 设计目的：低对比度 + 暖调，会议室投影 / 长时间阅读不刺眼。
        // 业务代码不动，Tailwind class 自动指向新值。
        bgDark: "#faf8f3",      // 页面底（暖米白）
        bgPanel: "#ffffff",     // 卡片底（纯白）
        bgPanel2: "#f0ece3",    // 次级面板（米色）

        // 主色：低饱和 sage 绿（替代鲜艳 teal）
        teal: "#6b9080",        // 主色（按钮、active、品牌）
        tealDeep: "#4f7361",    // hover / 深态

        // 强调色：暖琥珀（替代刺眼 amber）
        amber: "#c08552",

        // 文字：深石墨（暖调，避免纯黑）
        textMain: "#2c2a26",    // 正文
        textSub: "#75716a",     // 次要

        // 边框：米色细边
        border: "#e3ddd0",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
