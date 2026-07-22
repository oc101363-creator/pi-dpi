/**
 * session-browser：/sessions 浏览并恢复仓库存档会话（session-vcs 的读取侧）。
 *
 * - 扫描 <repo>/sessions/ 下各 agent 子目录（目录名即 agent 名，含 _legacy
 *   迁移区，/^[\w-]+$/ 白名单校验），解析每个 .jsonl：首行 header（timestamp/id/cwd）、最新一条
 *   session_info 的 name、首条 user 消息文本（content 为字符串或
 *   [{type:"text",text}] 数组都认）、user+assistant 消息计数、最后一条
 *   user/assistant 消息时间戳（排序键，缺失回退 header.timestamp）。
 *   >2MB 的大文件只读头 256KB，解析 header/首条消息后按文件名展示；
 *   坏行坏文件全部跳过，绝不抛出
 * - 主循环 select：`[<agent>] <name ?? 首条消息~36字符> · <N>条 · <相对时间>`，
 *   按排序键倒序；底部固定「◑ 筛选：全部|<当前agent>」（选中即在全部/当前
 *   agent 间切换并重绘，默认全部）与「✓ 完成」
 * - 选中会话 → 子菜单（标题 会话 — <name ?? 日期>）：「↩ 恢复到本机并切换」/
 *   「✕ 删除存档（git 可恢复）」/「← 返回」
 * - 恢复：复制进 ctx.sessionManager.getSessionDir()（同名已存在不覆盖，直接
 *   切换），首行 header 的 cwd 改写为本机 getCwd()（只改首行，其余行原样），
 *   然后 ctx.switchSession()；切换失败提示已复制、请用 /resume
 * - 非 UI 环境只 notify 各 agent 存档计数摘要；存档总数为 0 时提示无存档
 *
 * 内容仓库路径来自 dpi 配置；未绑定时提示先 /agent-login。
 * 文件读写逐步容错，绝不抛异常阻断 pi。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "../src/config.ts";

// 主列表末尾与子菜单的固定项
const DONE_ITEM = "✓ 完成";
const RESTORE_ITEM = "↩ 恢复到本机并切换";
const DELETE_ITEM = "✕ 删除存档（git 可恢复）";
const BACK_ITEM = "← 返回";

// >2MB 的存档只读头部 256KB（header 与首条消息都在头部），按文件名展示
const BIG_FILE_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;

interface ArchivedSession {
  agent: string; // sessions/ 下目录名（含 _legacy）
  path: string; // 存档文件绝对路径
  fileName: string; // basename（恢复时作目标文件名）
  name: string; // 最新 session_info.name；无则 ""
  firstUser: string; // 首条 user 消息文本（已压缩空白）
  messages: number; // user+assistant 消息数
  sortKey: number; // 排序键：最后 user/assistant 消息时间戳（ms），回退 header.timestamp
  dayLabel: string; // header.timestamp 的 YYYY-MM-DD（标题/通知的日期回退）
  partial: boolean; // >2MB 只解析了头部：按文件名展示、不计数
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 消息 content 取首段文本：字符串直取，数组找第一个 {type:"text",text} */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = part as Record<string, unknown> | null;
      if (p && p.type === "text" && typeof p.text === "string") return p.text;
    }
  }
  return "";
}

/** 行时间戳（ms）：entry.timestamp（ISO 字符串）优先，回退 message.timestamp（epoch ms） */
function lineTimestamp(
  rec: Record<string, unknown>,
  msg: Record<string, unknown> | null,
): number {
  const ts = rec.timestamp;
  if (typeof ts === "string") {
    const t = Date.parse(ts);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  const inner = msg?.timestamp;
  if (typeof inner === "number" && Number.isFinite(inner)) return inner;
  return 0;
}

/** 解析单个存档 .jsonl；坏文件返回 null（调用方跳过） */
function parseArchived(agent: string, path: string): ArchivedSession | null {
  try {
    const partial = statSync(path).size > BIG_FILE_BYTES;
    let text: string;
    if (partial) {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(HEAD_BYTES);
        const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
        text = buf.toString("utf-8", 0, n);
      } finally {
        closeSync(fd);
      }
    } else {
      text = readFileSync(path, "utf-8");
    }
    const entry: ArchivedSession = {
      agent,
      path,
      fileName: basename(path),
      name: "",
      firstUser: "",
      messages: 0,
      sortKey: 0,
      dayLabel: "",
      partial,
    };
    let parsedAny = false; // 是否解析出任何有效行（全坏行 = 坏文件，整体跳过）
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue; // 坏行宽容跳过
      }
      if (rec.type === "session") {
        parsedAny = true;
        if (typeof rec.timestamp === "string") {
          const t0 = Date.parse(rec.timestamp);
          if (!Number.isNaN(t0) && entry.sortKey === 0) entry.sortKey = t0; // header 兜底
          if (!entry.dayLabel) entry.dayLabel = rec.timestamp.slice(0, 10);
        }
        continue;
      }
      if (rec.type === "session_info") {
        parsedAny = true;
        if (typeof rec.name === "string" && rec.name.trim() !== "") {
          entry.name = rec.name.trim(); // 流式覆盖：取最新一条
        }
        continue;
      }
      if (rec.type !== "message") continue;
      const msg = (rec.message ?? null) as Record<string, unknown> | null;
      if (!msg) continue;
      const role = msg.role;
      if (role !== "user" && role !== "assistant") continue;
      parsedAny = true;
      entry.messages++;
      if (role === "user" && !entry.firstUser) {
        entry.firstUser = extractText(msg.content).replace(/\s+/g, " ").trim();
      }
      const ts = lineTimestamp(rec, msg);
      if (ts > 0) entry.sortKey = ts; // 流式覆盖：取最后一条
    }
    if (!parsedAny) return null; // 全坏行/空文件：坏文件跳过
    if (partial) {
      // 大文件按文件名展示：头部解析出的名字/计数会误导，丢弃
      entry.name = "";
      entry.firstUser = "";
      entry.messages = 0;
    }
    return entry;
  } catch {
    return null;
  }
}

/** 扫描 <repo>/sessions/ 下各 agent 子目录（含 _legacy）的全部存档；目录不存在/读失败回退空 */
function scanArchived(repo: string): ArchivedSession[] {
  try {
    const root = join(repo, "sessions");
    if (!existsSync(root)) return [];
    const out: ArchivedSession[] = [];
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^[\w-]+$/.test(dir.name)) continue;
      let files: string[] = [];
      try {
        files = readdirSync(join(root, dir.name)).filter((f: string) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const parsed = parseArchived(dir.name, join(root, dir.name, f));
        if (parsed) out.push(parsed);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 相对时间：刚刚 / N分钟前 / N小时前 / N天前 / N个月前 / N年前 */
function relTime(ms: number): string {
  if (ms <= 0) return "时间未知";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}天前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}个月前`;
  return `${Math.floor(mo / 12)}年前`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 列表条目标题：name ?? 首条消息（截断 ~36 字符）；partial 按文件名展示 */
function entryTitle(s: ArchivedSession): string {
  if (s.partial) return s.fileName;
  const t = (s.name || s.firstUser).replace(/\s+/g, " ").trim();
  return truncate(t || s.fileName, 36);
}

/** 子菜单标题/通知用的短名：name ?? 日期 */
function entryLabel(s: ArchivedSession): string {
  const t = s.name.replace(/\s+/g, " ").trim();
  return t || s.dayLabel || s.fileName;
}

/** 恢复：复制进本机会话目录（同名不覆盖）→ 改写首行 cwd → switchSession。返回是否已切换 */
async function restoreArchived(
  ctx: ExtensionCommandContext,
  s: ArchivedSession,
): Promise<boolean> {
  let dir = "";
  try {
    dir = ctx.sessionManager.getSessionDir();
  } catch {
    dir = "";
  }
  if (!dir) {
    ctx.ui.notify("恢复失败：拿不到本机会话目录，请手动复制存档后用 /resume", "error");
    return false;
  }
  const dest = join(dir, s.fileName);
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(dest)) {
      // 只改首行 header 的 cwd 为本机路径（避免 pi 在旧机器路径上跑），其余行原样
      const text = readFileSync(s.path, "utf-8");
      const nl = text.indexOf("\n");
      const head = nl < 0 ? text : text.slice(0, nl);
      const rest = nl < 0 ? "" : text.slice(nl);
      let out = text;
      try {
        const header = JSON.parse(head) as Record<string, unknown>;
        if (header.type === "session") {
          const cwd = ctx.sessionManager.getCwd();
          if (cwd) header.cwd = cwd;
          out = `${JSON.stringify(header)}${rest}`;
        }
      } catch {
        // 首行损坏/取 cwd 失败：原样写入
      }
      writeFileSync(dest, out, "utf-8");
    }
    // 目标已存在同名文件：跳过复制，直接切换
  } catch (e) {
    ctx.ui.notify(`复制存档失败：${errMsg(e)}`, "error");
    return false;
  }
  try {
    await ctx.switchSession(dest);
  } catch {
    ctx.ui.notify(`已复制到本机会话目录，请用 /resume 恢复（${entryLabel(s)}）`, "info");
    return false;
  }
  ctx.ui.notify(`已恢复：${entryLabel(s)}`, "info");
  return true;
}

/** 删除：confirm 确认 → unlinkSync（git 可恢复）。返回是否已删除 */
async function deleteArchived(
  ctx: ExtensionCommandContext,
  s: ArchivedSession,
): Promise<boolean> {
  const ok = await ctx.ui.confirm("删除会话存档", "删除该会话存档（git 可恢复）。确认？");
  if (!ok) return false;
  try {
    unlinkSync(s.path);
  } catch (e) {
    ctx.ui.notify(`删除失败：${errMsg(e)}`, "error");
    return false;
  }
  ctx.ui.notify("已删除会话存档", "info");
  return true;
}

export default function (pi: ExtensionAPI) {
  // /sessions：浏览仓库存档会话，一键恢复到本机并切换
  pi.registerCommand("sessions", {
    description: "浏览仓库存档会话，一键恢复到本机并切换",
    handler: async (_args, ctx) => {
      const cfg = loadConfig();
      if (!cfg.repoUrl) {
        ctx.ui.notify("未绑定内容仓库，请先 /agent-login", "warning");
        return;
      }
      const repo = cfg.repoPath;
      // 配置文件可被手工编辑，防御路径穿越：agent 名只允许纯目录名
      const agent = /^[\w-]+$/.test(cfg.currentAgent) ? cfg.currentAgent : "coder";

      let archived = scanArchived(repo);
      if (archived.length === 0) {
        ctx.ui.notify("仓库中还没有会话存档（/record on 后按 agent 自动归档）", "info");
        return;
      }

      if (!ctx.hasUI) {
        // 非 UI：只给各 agent 存档计数摘要
        const counts = new Map<string, number>();
        for (const s of archived) counts.set(s.agent, (counts.get(s.agent) ?? 0) + 1);
        const lines = [...counts.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([a, n]) => `${a}: ${n} 个`);
        ctx.ui.notify(`会话存档（共 ${archived.length} 个）\n${lines.join("\n")}`, "info");
        return;
      }

      // 主循环：按排序键倒序；「◑ 筛选」在 全部/当前 agent 间切换重绘，直到完成/取消
      let onlyCurrent = false;
      for (;;) {
        const shown = archived
          .filter((s) => !onlyCurrent || s.agent === agent)
          .sort((a, b) => b.sortKey - a.sortKey);
        const options = shown.map((s) => {
          const count = s.partial ? "" : ` · ${s.messages}条`;
          return `[${s.agent}] ${entryTitle(s)}${count} · ${relTime(s.sortKey)}`;
        });
        const filterItem = `◑ 筛选：${onlyCurrent ? agent : "全部"}`;
        options.push(filterItem, DONE_ITEM);
        const picked = await ctx.ui.select("会话存档", options);
        if (picked === undefined || picked === DONE_ITEM) break;
        if (picked === filterItem) {
          onlyCurrent = !onlyCurrent;
          continue;
        }
        // 选项字符串与 shown 顺序一一对应，按下标取回存档
        const idx = options.indexOf(picked);
        const target = idx >= 0 && idx < shown.length ? shown[idx] : undefined;
        if (!target) continue;

        // 子菜单：恢复 / 删除 / 返回
        const action = await ctx.ui.select(`会话 — ${truncate(entryLabel(target), 40)}`, [
          RESTORE_ITEM,
          DELETE_ITEM,
          BACK_ITEM,
        ]);
        if (action === RESTORE_ITEM) {
          if (await restoreArchived(ctx, target)) return; // 已切换会话：结束命令
          continue;
        }
        if (action === DELETE_ITEM) {
          if (await deleteArchived(ctx, target)) {
            archived = scanArchived(repo); // 删除后重扫刷新列表
            if (archived.length === 0) break;
          }
          continue;
        }
        // BACK_ITEM / 取消：返回主列表
      }
    },
  });
}
