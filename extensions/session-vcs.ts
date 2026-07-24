/**
 * session-vcs：会话落盘存档，按 agent 归档（移植自旧内容仓库 extensions/session-vcs.ts）。
 *
 * - session_shutdown：若 recordSessions 为 true，把 session JSONL 复制进
 *   内容仓库 sessions/<currentAgent>/ 目录（git 同步由 dpi-sync 负责）
 * - session_start：一次性迁移旧平铺档——把 <repo>/sessions/ 直属的 *.jsonl
 *   移入 sessions/_legacy/（renameSync，幂等；目录不存在跳过，单个失败容错继续）
 * - /record on|off|status：存档开关，写入 dpi 配置
 *
 * 会话自愈（坏消息清理）：
 * 网关 400/429 失败或用户中断（abort）时，pi 会把 content: [] 的空 assistant
 * 消息写入会话文件；此后每次请求都带上它，Anthropic 协议拒绝空消息 → 之后
 * 每一轮都 400，会话"死亡"。这里在两个时机自动清理：
 * - session_shutdown（quit）：归档前清理当前会话文件，归档进仓库的也是干净版
 * - session_start（new/resume/fork）：清理被替换下去的 previousSessionFile
 * 另有 /session-repair 手动修复当前会话（修的是磁盘文件，重进会话生效）。
 *
 * 未绑定内容仓库时静默跳过。agent 名 /^[\w-]+$/ 白名单校验防路径穿越，非法
 * 回退 _unknown；全部容错，绝不抛异常阻断 pi。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, saveConfig } from "../src/config.ts";

/**
 * 清理会话文件中的空 assistant 坏消息（content: []），有改动才写回。
 * 返回删除条数；文件缺失/损坏/无坏消息返回 0，绝不抛异常。
 * 判定不看 stopReason：正常 assistant 消息不会有空 content，空即坏消息。
 */
function repairSessionFile(file: string): number {
  try {
    if (!file || !existsSync(file)) return 0;
    const lines = readFileSync(file, "utf-8").split("\n");
    const kept: string[] = [];
    let removed = 0;
    for (const ln of lines) {
      if (ln.trim() === "") {
        kept.push(ln);
        continue;
      }
      let entry: { type?: string; message?: { role?: string; content?: unknown } };
      try {
        entry = JSON.parse(ln) as typeof entry;
      } catch {
        kept.push(ln); // 无法解析的行原样保留，绝不误删
        continue;
      }
      const msg = entry.message;
      if (
        entry.type === "message" &&
        msg?.role === "assistant" &&
        Array.isArray(msg.content) &&
        msg.content.length === 0
      ) {
        removed += 1;
        continue;
      }
      kept.push(ln);
    }
    if (removed > 0) writeFileSync(file, kept.join("\n"), "utf-8");
    return removed;
  } catch {
    return 0; // 修复失败不阻断任何流程
  }
}

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
  // 会话结束时：先清理坏消息，再把干净版 JSONL 复制进仓库 sessions/<agent>/ 目录
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const file = ctx.sessionManager.getSessionFile();
      if (file) repairSessionFile(file); // 自愈：坏消息不进归档、不毒害下次加载
      if (!loadConfig().recordSessions) return;
      const root = sessionsRoot();
      if (!root) return;
      if (!file || !existsSync(file)) return;
      const dir = join(root, archiveAgentName());
      mkdirSync(dir, { recursive: true });
      copyFileSync(file, join(dir, basename(file)));
    } catch {
      // 存档失败不阻断退出
    }
  });

  // 启动时清理被替换下去的旧会话文件（new/resume/fork 时事件携带其路径）
  pi.on("session_start", async (event) => {
    try {
      if (event.previousSessionFile) repairSessionFile(event.previousSessionFile);
    } catch {
      // 自愈失败静默
    }
    const root = sessionsRoot();
    if (!root) return;
    migrateLegacySessions(root);
  });

  pi.registerCommand("session-repair", {
    description: "会话自愈：清理当前会话文件中的空 assistant 坏消息（400/429/中断残留），重进会话生效",
    handler: async (_args, ctx) => {
      try {
        const file = ctx.sessionManager.getSessionFile();
        if (!file) {
          ctx.ui.notify("当前没有可修复的会话文件", "warning");
          return;
        }
        const removed = repairSessionFile(file);
        ctx.ui.notify(
          removed > 0
            ? `已清理 ${removed} 条坏消息。当前会话内存仍含残留，请退出后重新进入生效`
            : "会话文件健康，无需修复",
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`修复失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
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
