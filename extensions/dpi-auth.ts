/**
 * dpi-auth：内容仓库绑定与登录。
 *
 * - /agent-login [repoUrl]：GitHub OAuth device flow 授权 → 写 token（0600）
 *   → git clone 内容仓库 → 写配置 → ctx.reload() 让资源立即生效
 * - /agent-logout：清除本机 token（本地仓库与配置保留）
 *
 * 网络访问一律走 curl 子进程（自动吃 https_proxy 环境变量；显式代理加 -x），
 * 每一步独立容错，绝不抛出阻断 pi。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  defaultConfig,
  ensurePackageInSettings,
  hasToken,
  loadConfig,
  saveConfig,
  scanAgents,
  syncExtensionFilter,
  tokenPath,
  clearToken,
  writeToken,
} from "../src/config.ts";
import { git, gitIn } from "../src/git.ts";

const run = promisify(execFile);

// GitHub OAuth App（device flow 公共 client_id，非机密）
const CLIENT_ID = "Ov23liYebWamOAtuWqe3";
const SCOPE = "repo";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const HTTP_TIMEOUT = 20000;
const CLONE_TIMEOUT = 300000;
const LOGIN_WIDGET = "dpi-login";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** curl POST 表单（Accept: application/json），显式代理用 -x，否则吃环境变量 */
async function curlPostForm(
  url: string,
  form: Record<string, string>,
  proxy: string,
): Promise<Record<string, unknown>> {
  const args = ["-sS", "-X", "POST", "-H", "Accept: application/json"];
  if (proxy) args.push("-x", proxy);
  for (const [k, v] of Object.entries(form)) args.push("--data-urlencode", `${k}=${v}`);
  args.push(url);
  const { stdout } = await run("curl", args, { timeout: HTTP_TIMEOUT });
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`响应不是合法 JSON: ${stdout.slice(0, 200)}`);
  }
}

/**
 * 归一化仓库地址：容忍 user/repo、github.com/user/repo、https://…、git@… 输入，
 * 统一输出 https://github.com/user/repo.git；无法识别返回 null。
 */
function normalizeRepoUrl(input: string): string | null {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) return null;
  if (s.toLowerCase().startsWith("git@github.com:")) {
    s = s.slice("git@github.com:".length);
  } else {
    const m = /github\.com[/:]([^\s]+)$/i.exec(s);
    if (m) s = m[1];
  }
  s = s.replace(/\.git$/i, "").replace(/^\/+/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return null;
  return `https://github.com/${s}.git`;
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval?: number;
  expires_in?: number;
}

async function requestDeviceCode(proxy: string): Promise<DeviceCode> {
  const res = await curlPostForm(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE }, proxy);
  if (typeof res.device_code !== "string" || typeof res.user_code !== "string") {
    throw new Error(`设备码响应异常: ${JSON.stringify(res).slice(0, 200)}`);
  }
  return res as unknown as DeviceCode;
}

/** 轮询换 token：pending 继续等、slow_down +5s、过期/拒绝报错，最长到 expires_in */
async function pollForToken(dc: DeviceCode, proxy: string): Promise<string> {
  let interval = Math.max(dc.interval ?? 5, 5);
  const deadline = Date.now() + (dc.expires_in ?? 900) * 1000;
  for (;;) {
    if (Date.now() >= deadline) throw new Error("等待授权超时，授权码已过期");
    await sleep(interval * 1000);
    const res = await curlPostForm(
      ACCESS_TOKEN_URL,
      { client_id: CLIENT_ID, device_code: dc.device_code, grant_type: DEVICE_GRANT },
      proxy,
    );
    if (typeof res.access_token === "string" && res.access_token) return res.access_token;
    const err = res.error;
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval += 5;
      continue;
    }
    if (err === "expired_token") throw new Error("授权码已过期，请重新执行 /agent-login");
    if (err === "access_denied") throw new Error("授权被取消");
    throw new Error(`授权失败: ${String(err ?? "未知错误")}`);
  }
}

function clearLoginWidget(ctx: ExtensionCommandContext): void {
  if (ctx.hasUI) ctx.ui.setWidget(LOGIN_WIDGET, undefined);
}

/** 克隆（或复用已有）内容仓库到 repoPath，返回实际分支名 */
async function ensureRepo(
  ctx: ExtensionCommandContext,
  repoUrl: string,
  repoPath: string,
  proxy: string,
): Promise<string | null> {
  if (existsSync(repoPath)) {
    if (!existsSync(join(repoPath, ".git"))) {
      ctx.ui.notify(`目标目录已存在且不是 git 仓库：${repoPath}`, "error");
      return null;
    }
    // 已有本地仓库：重新指向 origin，跳过克隆
    try {
      await gitIn(repoPath, ["remote", "set-url", "origin", repoUrl], {
        tokenFile: tokenPath(),
        proxy,
      });
    } catch {
      // 指向失败不阻断绑定
    }
    ctx.ui.notify(`本地仓库已存在，跳过克隆：${repoPath}`, "info");
    try {
      const { stdout } = await gitIn(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return stdout.trim() || "main";
    } catch {
      return "main";
    }
  }
  // 优先按 main 克隆；远端默认分支不是 main 时退化为默认分支克隆
  try {
    await git(["clone", "--branch", "main", repoUrl, repoPath], {
      tokenFile: tokenPath(),
      proxy,
      timeoutMs: CLONE_TIMEOUT,
    });
    return "main";
  } catch (e) {
    if (!/branch|main/i.test(errMsg(e))) throw e;
    await git(["clone", repoUrl, repoPath], {
      tokenFile: tokenPath(),
      proxy,
      timeoutMs: CLONE_TIMEOUT,
    });
    try {
      const { stdout } = await gitIn(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return stdout.trim() || "main";
    } catch {
      return "main";
    }
  }
}

async function login(args: string, ctx: ExtensionCommandContext): Promise<void> {
  // 已有绑定：先确认是否重新绑定，取消不破坏现有配置
  const existing = loadConfig();
  if (existing.repoUrl && hasToken()) {
    const again = ctx.hasUI
      ? await ctx.ui.confirm("重新绑定", `已绑定内容仓库：\n${existing.repoUrl}\n是否重新绑定？`)
      : false;
    if (!again) {
      ctx.ui.notify("已取消，保持现有绑定", "info");
      return;
    }
  }

  // 1. 仓库地址
  let input = (args ?? "").trim();
  if (!input) {
    if (!ctx.hasUI) {
      ctx.ui.notify("用法: /agent-login <仓库地址>（如 github.com/user/repo）", "warning");
      return;
    }
    input = ((await ctx.ui.input("内容仓库地址", "github.com/oc101363-creator/Agent")) ?? "").trim();
    if (!input) {
      ctx.ui.notify("已取消", "info");
      return;
    }
  }
  const repoUrl = normalizeRepoUrl(input);
  if (!repoUrl) {
    ctx.ui.notify(`无法识别的仓库地址: ${input}`, "error");
    return;
  }

  // 2. 代理选择（无 UI 时走环境变量/直连）
  let proxy = "";
  if (ctx.hasUI) {
    const NO_PROXY = "不需要代理";
    const LOCAL_PROXY = "使用 127.0.0.1:7890（本地代理）";
    const CUSTOM = "自定义输入…";
    const picked = await ctx.ui.select("访问 GitHub 的代理设置", [NO_PROXY, LOCAL_PROXY, CUSTOM]);
    if (picked === undefined) {
      ctx.ui.notify("已取消", "info");
      return;
    }
    if (picked === LOCAL_PROXY) {
      proxy = "http://127.0.0.1:7890";
    } else if (picked === CUSTOM) {
      proxy = ((await ctx.ui.input("代理地址", "http://127.0.0.1:7890")) ?? "").trim();
      if (!proxy) {
        ctx.ui.notify("已取消", "info");
        return;
      }
    }
  }

  // 3. device flow：取设备码
  let dc: DeviceCode;
  try {
    dc = await requestDeviceCode(proxy);
  } catch (e) {
    ctx.ui.notify(
      `获取设备授权码失败：${errMsg(e)}\n请检查网络/代理设置${proxy ? `（当前代理: ${proxy}）` : "（未配置代理）"}`,
      "error",
    );
    return;
  }

  // 4. 展示授权码（widget 持久显示 + notify 兜底），轮询等待授权
  ctx.ui.notify(`GitHub 授权：打开 ${dc.verification_uri} ，输入代码 ${dc.user_code}`, "info");
  if (ctx.hasUI) {
    ctx.ui.setWidget(LOGIN_WIDGET, [
      "GitHub 设备授权",
      `  1. 浏览器打开 ${dc.verification_uri}`,
      `  2. 输入代码 ${dc.user_code}`,
      "  等待授权完成…",
    ]);
  }
  let token: string;
  try {
    token = await pollForToken(dc, proxy);
  } catch (e) {
    ctx.ui.notify(`授权未完成：${errMsg(e)}`, "error");
    return;
  } finally {
    clearLoginWidget(ctx);
  }
  writeToken(token);
  ctx.ui.notify("授权成功，正在克隆内容仓库…", "info");

  // 5. 克隆内容仓库（token 已落盘，克隆失败可重跑 /agent-login 复用）
  const repoPath = defaultConfig().repoPath;
  let branch: string | null;
  try {
    branch = await ensureRepo(ctx, repoUrl, repoPath, proxy);
  } catch (e) {
    ctx.ui.notify(
      `克隆失败：${errMsg(e)}\n请检查网络/代理设置后重新执行 /agent-login`,
      "error",
    );
    return;
  }
  if (!branch) return; // 目标目录被占用的错误已提示

  // 6. 写配置；currentAgent 若在新仓库中不存在则回退到第一个可用 agent
  const agents = scanAgents(repoPath);
  const patch: Record<string, unknown> = { repoUrl, repoPath, branch, proxy };
  if (agents.length > 0 && !agents.includes(existing.currentAgent)) {
    patch.currentAgent = agents[0];
  }
  saveConfig(patch);

  // 声明式关键一步：把内容包路径写进 settings.json packages，
  // 之后技能/提示词/主题由 pi 原生按包规则加载，引擎不再代劳
  const declared = ensurePackageInSettings(repoPath);

  ctx.ui.notify(
    `绑定成功 ✓\n仓库: ${repoUrl}\n本地: ${repoPath}\n可用 agents: ${agents.join(", ") || "（未发现 agents/*/SYSTEM.md）"}${declared ? "\n已声明为 pi 包（settings.json）" : ""}`,
    "info",
  );

  // 7. 重载扩展与资源，让 resources_discover 立即生效；
  // reload 前同步扩展过滤器，让内容包扩展按当前 agent 声明隔离加载
  syncExtensionFilter(loadConfig());
  try {
    await ctx.reload();
  } catch {
    // reload 失败不影响绑定结果
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("agent-login", {
    description: "绑定内容仓库：GitHub device flow 登录 + 克隆（/agent-login [仓库地址]）",
    handler: async (args, ctx) => {
      try {
        await login(args, ctx);
      } catch (e) {
        clearLoginWidget(ctx);
        ctx.ui.notify(`登录失败：${errMsg(e)}`, "error");
      }
    },
  });

  pi.registerCommand("agent-logout", {
    description: "退出登录：清除本机 GitHub token（本地仓库与配置保留）",
    handler: async (_args, ctx) => {
      try {
        if (!hasToken()) {
          ctx.ui.notify("当前未登录", "info");
          return;
        }
        const ok = ctx.hasUI
          ? await ctx.ui.confirm("退出登录", "清除本机保存的 GitHub token？\n（本地仓库与配置保留，同步将停止）")
          : false;
        if (!ok) {
          ctx.ui.notify("已取消", "info");
          return;
        }
        clearToken();
        ctx.ui.notify("已退出登录：token 已清除，本地仓库与配置保留", "info");
      } catch (e) {
        ctx.ui.notify(`退出失败：${errMsg(e)}`, "error");
      }
    },
  });
}
