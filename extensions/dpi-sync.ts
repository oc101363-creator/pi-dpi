/**
 * dpi-sync：内容仓库自动同步。
 *
 * - session_start（仅 reason==="startup"）：pull --rebase --autostash → 有改动才
 *   commit "[sync] sweep" → push
 * - session_shutdown：sweep → push
 * - /sync：手动执行完整同步并反馈结果
 *
 * 每步独立 try/catch 静默容错（自动路径 8s 超时）；github/http 远端带 credential
 * helper 与按需代理，ssh/local 远端零凭证不注入 helper、不走 http 代理。
 * 未绑定仓库或需要令牌的远端未登录时直接跳过。git 失败绝不能影响 pi 启动/退出。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasToken, loadConfig, remoteNeedsToken, tokenPath } from "../src/config.ts";
import { GIT_TIMEOUT, gitIn } from "../src/git.ts";
import type { GitOptions } from "../src/git.ts";

interface SyncTarget {
  repoPath: string;
  opts: GitOptions;
}

/** 同步前提检查：已绑定 + 需要令牌的类型已登录 + 本地仓库存在；不满足返回 null */
function target(): SyncTarget | null {
  const cfg = loadConfig();
  if (!cfg.repoUrl || (remoteNeedsToken(cfg.remoteKind) && !hasToken())) return null;
  if (!existsSync(join(cfg.repoPath, ".git"))) return null;
  // ssh/local 零凭证：不注入 credential helper，也不走 http 代理
  const opts: GitOptions = remoteNeedsToken(cfg.remoteKind)
    ? { tokenFile: tokenPath(), proxy: cfg.proxy, timeoutMs: GIT_TIMEOUT }
    : { noAuth: true, proxy: "", timeoutMs: GIT_TIMEOUT };
  return { repoPath: cfg.repoPath, opts };
}

/** 清扫：暂存全部改动，有变更才提交；返回是否有提交产生 */
async function sweep(t: SyncTarget, message: string): Promise<boolean> {
  await gitIn(t.repoPath, ["add", "-A"], t.opts);
  const { stdout } = await gitIn(t.repoPath, ["status", "--porcelain"], t.opts);
  if (stdout.trim().length === 0) return false;
  await gitIn(t.repoPath, ["commit", "-m", message], t.opts);
  return true;
}

async function autoSync(onStartup: boolean): Promise<void> {
  const t = target();
  if (!t) return;
  if (onStartup) {
    try {
      await gitIn(t.repoPath, ["pull", "--rebase", "--autostash"], t.opts);
    } catch {
      // 拉取失败（离线/冲突）静默，不阻塞启动
    }
  }
  try {
    await sweep(t, "[sync] sweep");
  } catch {
    // 清扫失败静默
  }
  try {
    await gitIn(t.repoPath, ["push"], t.opts);
  } catch {
    // 推送失败静默
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event) => {
    if (event.reason !== "startup") return;
    try {
      await autoSync(true);
    } catch {
      // 绝不阻塞启动
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      await autoSync(false);
    } catch {
      // 静默
    }
  });

  // /sync：手动完整同步（拉 → 扫 → 推），结果显式反馈
  pi.registerCommand("sync", {
    description: "手动同步内容仓库：pull --rebase → 清扫提交 → push",
    handler: async (_args, ctx) => {
      const t = target();
      if (!t) {
        ctx.ui.notify("未绑定内容仓库或未登录，请先 /agent-login", "warning");
        return;
      }
      try {
        await gitIn(t.repoPath, ["pull", "--rebase", "--autostash"], {
          ...t.opts,
          timeoutMs: 60000,
        });
        const committed = await sweep(t, "[sync] sweep");
        await gitIn(t.repoPath, ["push"], { ...t.opts, timeoutMs: 60000 });
        ctx.ui.notify(committed ? "同步完成：已清扫提交并推送" : "同步完成：无本地改动，已拉取并推送", "info");
      } catch (e) {
        ctx.ui.notify(`同步失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
