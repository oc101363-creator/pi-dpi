/**
 * skill-manager：/skills 交互管理当前 agent 的技能组合。
 *
 * - 主循环：select 列出仓库根 skills/ 注册表全部技能（SKILL.md frontmatter 的
 *   description 作选项后缀，截断 ~40 字符），当前 agent 已声明的 ✅、未声明 ⬜；
 *   选中即切换勾选并立即写回 agents/<current>/agent.json，随后重绘列表
 * - 列表末尾固定特殊项：「🗑 删除注册表技能…」（rm 目录 + 从所有 agent 声明中剔除）
 *   与「✔ 完成」（ctx.reload() 让 resources_discover 按新组合生效）
 * - 非 UI 环境只 notify 当前 agent 已声明的技能列表
 *
 * 内容仓库路径全部来自 dpi 配置（config.repoPath）；未绑定时提示先 /agent-login。
 * agent 名与技能名一律 /^[\w-]+$/ 白名单校验防路径穿越；文件读写逐步容错，绝不抛出。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  readAgentManifest,
  writeAgentManifestSkills,
} from "../src/config.ts";

// 主列表末尾的两个固定特殊项
const DELETE_ITEM = "🗑 删除注册表技能…";
const DONE_ITEM = "✔ 完成";

interface RegistrySkill {
  name: string;
  description: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 读 skills/<name>/SKILL.md frontmatter 的 description（单行），截断 ~40 字符 */
function skillDescription(path: string): string {
  try {
    const head = readFileSync(path, "utf-8").slice(0, 4000);
    const fm = /^---\n([\s\S]*?)\n---/.exec(head);
    if (!fm) return "";
    const line = fm[1].split("\n").find((l) => /^description\s*:/.test(l));
    if (!line) return "";
    const desc = line
      .replace(/^description\s*:\s*/, "")
      .trim()
      .replace(/^["']|["']$/g, "");
    // YAML 折叠/块标量（>、| 开头）无法单行展示，按无描述处理
    if (!desc || /^[>|]/.test(desc)) return "";
    return desc.length > 40 ? `${desc.slice(0, 39)}…` : desc;
  } catch {
    return "";
  }
}

/** 扫描仓库根 skills/ 注册表：含 SKILL.md 的子目录（目录名白名单校验），按名排序 */
function scanRegistrySkills(repo: string): RegistrySkill[] {
  try {
    const dir = join(repo, "skills");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          /^[\w-]+$/.test(e.name) &&
          existsSync(join(dir, e.name, "SKILL.md")),
      )
      .map((e) => ({ name: e.name, description: skillDescription(join(dir, e.name, "SKILL.md")) }))
      .sort((a, b) => a.name.localeCompare(b.name));
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

/** 删除流程：选技能 → confirm 确认 → rm 目录 + 从所有 agent 声明中剔除；取消即返回主列表 */
async function deleteSkillFlow(ctx: ExtensionCommandContext, repo: string): Promise<boolean> {
  const registry = scanRegistrySkills(repo);
  if (registry.length === 0) {
    ctx.ui.notify("注册表中没有可删除的技能", "info");
    return false;
  }
  const options = registry.map((s) => (s.description ? `${s.name} — ${s.description}` : s.name));
  const picked = await ctx.ui.select("选择要删除的注册表技能", options);
  if (picked === undefined) return false; // 取消：返回主列表
  const idx = options.indexOf(picked);
  const name = idx >= 0 ? registry[idx].name : "";
  if (!/^[\w-]+$/.test(name)) return false;
  const ok = await ctx.ui.confirm(
    "删除注册表技能",
    `将删除 skills/${name}/ 目录，并从所有 agent 的 agent.json 声明中移除「${name}」。\n目录已纳入 git，可随时通过历史恢复。确认删除？`,
  );
  if (!ok) return false;
  try {
    rmSync(join(repo, "skills", name), { recursive: true, force: true });
  } catch (e) {
    ctx.ui.notify(`删除 skills/${name}/ 失败：${errMsg(e)}`, "error");
    return false;
  }
  // 同步剔除所有 agent 的声明，避免残留指向已删除目录的技能名
  let affected = 0;
  for (const agent of scanManifestAgents(repo)) {
    const manifest = readAgentManifest(repo, agent);
    if (!manifest.skills.includes(name)) continue;
    if (writeAgentManifestSkills(repo, agent, manifest.skills.filter((s) => s !== name))) {
      affected++;
    }
  }
  ctx.ui.notify(`已删除技能「${name}」，并移除 ${affected} 个 agent 的声明`, "info");
  return true;
}

export default function (pi: ExtensionAPI) {
  // /skills：交互勾选/取消当前 agent 的技能，或删除注册表技能
  pi.registerCommand("skills", {
    description: "交互管理当前 agent 的技能组合（勾选/删除注册表技能）",
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
          `当前 agent: ${agent}\n已声明技能: ${manifest.skills.join(", ") || "（无）"}`,
          "info",
        );
        return;
      }

      // 主循环：每次重读声明与注册表，选中即切换并立即写回，直到完成/取消
      let dirty = false;
      for (;;) {
        const registry = scanRegistrySkills(repo);
        const declared = readAgentManifest(repo, agent).skills;
        const options = registry.map((s) => {
          const mark = declared.includes(s.name) ? "✅" : "⬜";
          return s.description ? `${mark} ${s.name} — ${s.description}` : `${mark} ${s.name}`;
        });
        options.push(DELETE_ITEM, DONE_ITEM);
        const picked = await ctx.ui.select(
          `管理技能（当前 agent: ${agent}）— 选中即切换勾选`,
          options,
        );
        if (picked === undefined || picked === DONE_ITEM) break;
        if (picked === DELETE_ITEM) {
          if (await deleteSkillFlow(ctx, repo)) dirty = true;
          continue;
        }
        // 选项字符串与注册表顺序一一对应，按下标取回技能名
        const idx = options.indexOf(picked);
        const name = idx >= 0 && idx < registry.length ? registry[idx].name : "";
        if (!/^[\w-]+$/.test(name)) continue;
        const next = declared.includes(name)
          ? declared.filter((s) => s !== name)
          : [...declared, name];
        if (writeAgentManifestSkills(repo, agent, next)) {
          dirty = true;
        } else {
          ctx.ui.notify(`写入 agents/${agent}/agent.json 失败`, "error");
        }
      }

      if (!dirty) {
        ctx.ui.notify("未做更改", "info");
        return;
      }
      // 重载让 resources_discover 按新组合重新发现技能；失败不吞掉已写入的声明
      try {
        await ctx.reload();
      } catch {
        // reload 失败不影响已保存的组合
      }
      ctx.ui.notify("已保存，/sync 或重启 pi 后同步到 GitHub", "info");
    },
  });
}
