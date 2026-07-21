/**
 * dpi 共享配置模块：被 extensions/ 下各扩展以相对路径 import。
 *
 * 约定：
 * - 纯函数 + 类型，import 时零副作用（目录创建延迟到写入时刻）；
 * - 本文件不放在 extensions/ 下——pi 会把 extensions/ 里每个 .ts 当扩展加载，
 *   没有 default 导出函数的文件会产生加载错误；
 * - 所有读取一律容错回退默认，绝不抛异常阻断 pi 启动。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** dpi 持久化配置（~/.pi/agent/dpi/config.json） */
export interface DpiConfig {
  /** 内容仓库地址（归一化为 https://github.com/user/repo.git）；空串 = 未绑定 */
  repoUrl: string;
  /** 内容仓库本地克隆路径，默认 <agentDir>/dpi/repo */
  repoPath: string;
  /** 同步分支，默认 main */
  branch: string;
  /** 显式代理（如 http://127.0.0.1:7890）；空串 = 走环境变量/直连 */
  proxy: string;
  /** 当前激活 agent，默认 coder */
  currentAgent: string;
  /** 会话存档开关，默认 true */
  recordSessions: boolean;
}

const DEFAULTS: DpiConfig = {
  repoUrl: "",
  repoPath: "",
  branch: "main",
  proxy: "",
  currentAgent: "coder",
  recordSessions: true,
};

/** pi 的 agent 目录（与 pi 本体约定一致） */
export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** dpi 私有目录路径（纯计算，不创建目录） */
export function dpiDir(): string {
  return join(agentDir(), "dpi");
}

/** 确保 dpi 目录存在且为 0700（抄 pi auth-storage 约定）；仅写入路径调用 */
function ensureDpiDir(): string {
  const dir = dpiDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // chmod 失败不致命
  }
  return dir;
}

export function configPath(): string {
  return join(dpiDir(), "config.json");
}

export function tokenPath(): string {
  return join(dpiDir(), "token");
}

/** 完整默认配置（repoPath 在此展开为绝对路径） */
export function defaultConfig(): DpiConfig {
  return { ...DEFAULTS, repoPath: join(dpiDir(), "repo") };
}

/** 读取配置；文件缺失/损坏/字段类型错误一律回退默认，绝不抛异常 */
export function loadConfig(): DpiConfig {
  const cfg = defaultConfig();
  try {
    if (!existsSync(configPath())) return cfg;
    const raw = JSON.parse(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
    if (typeof raw.repoUrl === "string") cfg.repoUrl = raw.repoUrl;
    if (typeof raw.repoPath === "string" && raw.repoPath !== "") cfg.repoPath = raw.repoPath;
    if (typeof raw.branch === "string" && raw.branch !== "") cfg.branch = raw.branch;
    if (typeof raw.proxy === "string") cfg.proxy = raw.proxy;
    if (typeof raw.currentAgent === "string" && raw.currentAgent !== "") {
      cfg.currentAgent = raw.currentAgent;
    }
    if (typeof raw.recordSessions === "boolean") cfg.recordSessions = raw.recordSessions;
  } catch {
    // 配置文件损坏：整体回退默认
  }
  return cfg;
}

/** 合并写入配置（读取-合并-整体覆写） */
export function saveConfig(patch: Partial<DpiConfig>): DpiConfig {
  const next = { ...loadConfig(), ...patch };
  ensureDpiDir();
  writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

export function hasToken(): boolean {
  return readToken() !== "";
}

/** 读取 token；缺失/损坏返回空串 */
export function readToken(): string {
  try {
    if (!existsSync(tokenPath())) return "";
    return readFileSync(tokenPath(), "utf-8").trim();
  } catch {
    return "";
  }
}

/** 写 token：文件 0600，写后 chmod 兜底（抄 pi auth-storage 约定） */
export function writeToken(token: string): void {
  ensureDpiDir();
  writeFileSync(tokenPath(), `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(tokenPath(), 0o600);
  } catch {
    // chmod 失败不致命
  }
}

/** 清除 token；文件不存在视为已清除 */
export function clearToken(): void {
  try {
    unlinkSync(tokenPath());
  } catch {
    // 不存在视为已清除
  }
}

/** 扫描内容仓库 agents/ 下所有含 SYSTEM.md 的子目录，得到可用 agent 列表 */
export function scanAgents(repoPath: string): string[] {
  try {
    const agentsDir = join(repoPath, "agents");
    if (!existsSync(agentsDir)) return [];
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(agentsDir, e.name, "SYSTEM.md")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 把内容仓库的本地路径声明进 pi 的 settings.json packages（声明式加载的关键一步）。
 * 已在列表中（字符串或对象形式）则不重复添加。返回是否有改动。
 * 注意：pi 运行中改写 settings.json 后需要 ctx.reload() 才会生效（调用方负责）。
 */
export function ensurePackageInSettings(source: string): boolean {
  const settingsPath = join(agentDir(), "settings.json");
  try {
    const raw = existsSync(settingsPath)
      ? (JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>)
      : {};
    const packages = Array.isArray(raw.packages) ? [...(raw.packages as unknown[])] : [];
    const declared = packages.some((p) =>
      typeof p === "string" ? p === source : (p as { source?: unknown })?.source === source,
    );
    if (declared) return false;
    packages.push(source);
    raw.packages = packages;
    writeFileSync(settingsPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false; // settings 读写失败不阻断绑定流程
  }
}
