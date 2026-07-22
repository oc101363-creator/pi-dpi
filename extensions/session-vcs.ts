/**
 * session-vcs：会话落盘存档，按 agent 归档（移植自旧内容仓库 extensions/session-vcs.ts）。
 *
 * - session_shutdown：若 recordSessions 为 true，把 session JSONL 复制进
 *   内容仓库 sessions/<currentAgent>/ 目录（git 同步由 dpi-sync 负责）
 * - session_start：一次性迁移旧平铺档——把 <repo>/sessions/ 直属的 *.jsonl
 *   移入 sessions/_legacy/（renameSync，幂等；目录不存在跳过，单个失败容错继续）
 * - /record on|off|status：存档开关，写入 dpi 配置
 *
 * 未绑定内容仓库时静默跳过。agent 名 /^[\w-]+$/ 白名单校验防路径穿越，非法
 * 回退 _unknown；全部容错，绝不抛异常阻断 pi。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, saveConfig } from "../src/config.ts";

// 存档根目录 <repo>/sessions：未绑定内容仓库时返回 null
function sessionsRoot(): string | null {
  const cfg = loadConfig();
  return cfg.repoUrl ? join(cfg.repoPath, "sessions") : null;
}

// 当前 agent 的存档子目录名（白名单校验，非法回退 _unknown）
function archiveAgentName(): string {
  const { currentAgent } = loadConfig();
  return /^[\w-]+$/.test(currentAgent) ? currentAgent : "_unknown";
}

/** 一次性迁移：sessions/ 直属的平铺 *.jsonl → sessions/_legacy/（幂等，逐步容错） */
function migrateLegacySessions(root: string): void {
  try {
    if (!existsSync(root)) return; // 存档目录不存在：跳过
    const flat = readdirSync(root, { withFileTypes: true }).filter(
      (e) => e.isFile() && e.name.endsWith(".jsonl"),
    );
    if (flat.length === 0) return;
    const legacy = join(root, "_legacy");
    mkdirSync(legacy, { recursive: true });
    for (const e of flat) {
      try {
        renameSync(join(root, e.name), join(legacy, e.name));
      } catch {
        // 单个失败容错继续（下次 session_start 再迁）
      }
    }
  } catch {
    // 迁移失败不阻断会话启动
  }
}

export default function (pi: ExtensionAPI) {
  // 会话结束时把 session JSONL 复制进仓库 sessions/<agent>/ 目录
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      if (!loadConfig().recordSessions) return;
      const root = sessionsRoot();
      if (!root) return;
      const file = ctx.sessionManager.getSessionFile();
      if (!file || !existsSync(file)) return;
      const dir = join(root, archiveAgentName());
      mkdirSync(dir, { recursive: true });
      copyFileSync(file, join(dir, basename(file)));
    } catch {
      // 存档失败不阻断退出
    }
  });

  // 迁移旧平铺存档（幂等，每次会话启动跑一次；无平铺档时零开销退出）
  pi.on("session_start", async () => {
    const root = sessionsRoot();
    if (!root) return;
    migrateLegacySessions(root);
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
