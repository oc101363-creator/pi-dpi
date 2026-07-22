/**
 * ext-manager：/extensions 交互管理当前 agent 的扩展组合（与 skill-manager 对称）。
 *
 * - 主循环：select 列出仓库根 extensions/ 注册表全部扩展（只认顶层 .ts 文件，
 *   basename 去 .ts 得扩展名），已声明的排前标 ●、未声明的排后标 ○，
 *   各自按名称排序；选中即切换勾选并立即写回 agents/<current>/agent.json，
 *   不打扰，重绘列表自然反映勾选状态
 * - 列表末尾固定特殊项：「✕ 删除注册表扩展…」（rm 文件 + 从所有 agent 声明中剔除）
 *   与「✓ 完成」（有改动则先 syncExtensionFilter 同步过滤器，再 ctx.reload()
 *   让 pi 按新白名单重载内容包扩展——过滤发生在 import 之前，未声明的扩展不执行）
 * - 非 UI 环境只 notify 当前 agent 已声明的扩展列表
 *
 * 内容仓库路径全部来自 dpi 配置（config.repoPath）；未绑定时提示先 /agent-login。
 * agent 名与扩展名一律 /^[\w-]+$/ 白名单校验防路径穿越；文件读写逐步容错，绝不抛出。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  readAgentManifest,
  syncExtensionFilter,
  writeAgentManifestExtensions,
} from "../src/config.ts";

// 主列表末尾的两个固定特殊项
const DELETE_ITEM = "✕ 删除注册表扩展…";
const DONE_ITEM = "✓ 完成";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 扫描仓库根 extensions/ 注册表：只认顶层 .ts 文件（basename 白名单校验），按名排序 */
function scanRegistryExtensions(repo: string): string[] {
  try {
    const dir = join(repo, "extensions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /^[\w-]+\.ts$/.test(e.name))
      .map((e) => e.name.replace(/\.ts$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/** agents/ 下所有含 agent.json 的子目录名（白名单校验），供删除时批量剔除声明 */
function scanManifestAgents(repo: string): string[] {
  try {
    const dir = join(repo, "agents");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          /^[\w-]+$/.test(e.name) &&
          existsSync(join(dir, e.name, "agent.json")),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** 删除流程：选扩展 → confirm 确认 → rm 文件 + 从所有 agent 声明中剔除；取消即返回主列表 */
async function deleteExtensionFlow(
  ctx: ExtensionCommandContext,
  repo: string,
): Promise<boolean> {
  const registry = scanRegistryExtensions(repo);
  if (registry.length === 0) {
    ctx.ui.notify("注册表中没有可删除的扩展", "info");
    return false;
  }
  const picked = await ctx.ui.select("删除扩展 — 选择目标", registry);
  if (picked === undefined) return false; // 取消：返回主列表
  const name = registry.find((n) => n === picked) ?? "";
  if (!/^[\w-]+$/.test(name)) return false;
  const ok = await ctx.ui.confirm(
    "删除注册表扩展",
    `删除 extensions/${name}.ts 并从所有 agent 声明中移除（git 可恢复）。确认？`,
  );
  if (!ok) return false;
  try {
    rmSync(join(repo, "extensions", `${name}.ts`), { force: true });
  } catch (e) {
    ctx.ui.notify(`删除 extensions/${name}.ts 失败：${errMsg(e)}`, "error");
    return false;
  }
  // 同步剔除所有 agent 的声明，避免残留指向已删除文件的扩展名
  let affected = 0;
  for (const agent of scanManifestAgents(repo)) {
    const manifest = readAgentManifest(repo, agent);
    if (!manifest.extensions.includes(name)) continue;
    if (writeAgentManifestExtensions(repo, agent, manifest.extensions.filter((s) => s !== name))) {
      affected++;
    }
  }
  ctx.ui.notify(`已删除 ${name}（影响 ${affected} 个 agent）`, "info");
  return true;
}

export default function (pi: ExtensionAPI) {
  // /extensions：交互勾选/取消当前 agent 的扩展，或删除注册表扩展
  pi.registerCommand("extensions", {
    description: "交互管理当前 agent 的扩展组合（勾选/删除注册表扩展）",
    handler: async (_args, ctx) => {
      const cfg = loadConfig();
      if (!cfg.repoUrl) {
        ctx.ui.notify("未绑定内容仓库，请先 /agent-login", "warning");
        return;
      }
      const repo = cfg.repoPath;
      // 配置文件可被手工编辑，防御路径穿越：agent 名只允许纯目录名
      const agent = /^[\w-]+$/.test(cfg.currentAgent) ? cfg.currentAgent : "coder";

      if (!ctx.hasUI) {
        const manifest = readAgentManifest(repo, agent);
        ctx.ui.notify(
          `当前 agent: ${agent}\n已声明扩展: ${manifest.extensions.join(", ") || "（无）"}`,
          "info",
        );
        return;
      }

      // 主循环：每次重读声明与注册表，已声明的排前、未声明的排后（各自按名排序），
      // 选中即切换并立即写回（不打扰，重绘自然反映勾选状态），直到完成/取消
      let dirty = false;
      for (;;) {
        const registry = scanRegistryExtensions(repo);
        const declared = readAgentManifest(repo, agent).extensions;
        const ordered = [
          ...registry.filter((name) => declared.includes(name)),
          ...registry.filter((name) => !declared.includes(name)),
        ];
        const options = ordered.map((name) =>
          declared.includes(name) ? `● ${name}` : `○ ${name}`,
        );
        options.push(DELETE_ITEM, DONE_ITEM);
        const picked = await ctx.ui.select(`扩展 — ${agent}`, options);
        if (picked === undefined || picked === DONE_ITEM) break;
        if (picked === DELETE_ITEM) {
          if (await deleteExtensionFlow(ctx, repo)) dirty = true;
          continue;
        }
        // 选项字符串与排序后注册表顺序一一对应，按下标取回扩展名
        const idx = options.indexOf(picked);
        const name = idx >= 0 && idx < ordered.length ? ordered[idx] : "";
        if (!/^[\w-]+$/.test(name)) continue;
        const next = declared.includes(name)
          ? declared.filter((s) => s !== name)
          : [...declared, name];
        if (writeAgentManifestExtensions(repo, agent, next)) {
          dirty = true;
        } else {
          ctx.ui.notify(`写入 agents/${agent}/agent.json 失败`, "error");
        }
      }

      if (!dirty) return; // 未改动：不打扰，直接返回
      // 先同步内容包 extensions 过滤器，再重载让 pi 按新白名单加载扩展；
      // 失败不吞掉已写入的声明
      syncExtensionFilter(loadConfig());
      try {
        await ctx.reload();
      } catch {
        // reload 失败不影响已保存的组合
      }
      const count = readAgentManifest(repo, agent).extensions.length;
      ctx.ui.notify(`已保存：${agent} 现在启用 ${count} 个扩展`, "info");
    },
  });
}
