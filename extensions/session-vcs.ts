/**
 * session-vcs：会话落盘存档（移植自旧内容仓库 extensions/session-vcs.ts）。
 *
 * - session_shutdown：若 recordSessions 为 true，把 session JSONL 复制进
 *   内容仓库 sessions/ 目录（git 同步由 dpi-sync 负责）
 * - /record on|off|status：存档开关，写入 dpi 配置
 *
 * 未绑定内容仓库时静默跳过。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, saveConfig } from "../src/config.ts";

// 存档目录：未绑定内容仓库时返回 null
function sessionsDir(): string | null {
  const cfg = loadConfig();
  return cfg.repoUrl ? join(cfg.repoPath, "sessions") : null;
}

export default function (pi: ExtensionAPI) {
  // 会话结束时把 session JSONL 复制进仓库 sessions/ 目录
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!loadConfig().recordSessions) return;
    const dir = sessionsDir();
    if (!dir) return;
    const file = ctx.sessionManager.getSessionFile();
    if (!file || !existsSync(file)) return;
    mkdirSync(dir, { recursive: true });
    copyFileSync(file, join(dir, basename(file)));
  });

  pi.registerCommand("record", {
    description: "会话存档开关：/record on|off|status",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "on" || sub === "off") {
        saveConfig({ recordSessions: sub === "on" });
        ctx.ui.notify(`会话存档已${sub === "on" ? "开启" : "关闭"}`, "info");
        return;
      }
      if (sub === "status" || sub === "") {
        ctx.ui.notify(
          `会话存档当前状态：${loadConfig().recordSessions ? "on（开启）" : "off（关闭）"}`,
          "info",
        );
        return;
      }
      ctx.ui.notify("用法: /record on|off|status", "warning");
    },
  });
}
