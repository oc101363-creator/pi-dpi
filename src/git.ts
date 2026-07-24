/**
 * git 子进程共享助手：credential helper 认证 + 可选显式代理 + 超时兜底。
 * token 绝不写进 remote URL，走一次性 credential helper 从 0600 token 文件读取。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 自动同步类 git 操作的统一超时 */
export const GIT_TIMEOUT = 8000;

/**
 * 认证参数：清空外部 helper，改用从 token 文件读凭证的一次性 helper。
 * token 文件为两行（用户名\n令牌，通用 HTTPS）时逐行对应输出；
 * 单行旧格式沿用 GitHub 惯例 username=x-access-token、password=该行。
 */
export function gitAuthArgs(tokenFile: string): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=!f() { L1=$(sed -n 1p "${tokenFile}"); L2=$(sed -n 2p "${tokenFile}"); if [ -n "$L2" ]; then echo "username=$L1"; echo "password=$L2"; else echo username=x-access-token; echo "password=$L1"; fi; }; f`,
  ];
}

/** 代理参数：仅当显式配置了代理时注入（否则由 git 走环境变量/直连） */
export function gitProxyArgs(proxy: string): string[] {
  return proxy ? ["-c", `http.proxy=${proxy}`] : [];
}

export interface GitOptions {
  tokenFile?: string;
  /** 为 true 时不注入 credential helper（ssh/local 远端零凭证） */
  noAuth?: boolean;
  proxy?: string;
  timeoutMs?: number;
}

function buildPrefix(opts: GitOptions): string[] {
  return [
    ...(opts.tokenFile && !opts.noAuth ? gitAuthArgs(opts.tokenFile) : []),
    ...gitProxyArgs(opts.proxy ?? ""),
  ];
}

/** 在指定仓库目录内执行 git（自动带 -C） */
export async function gitIn(cwd: string, args: string[], opts: GitOptions = {}) {
  return run("git", ["-C", cwd, ...buildPrefix(opts), ...args], {
    timeout: opts.timeoutMs ?? GIT_TIMEOUT,
  });
}

/** 执行与仓库目录无关的 git 命令（如 clone） */
export async function git(args: string[], opts: GitOptions = {}) {
  return run("git", [...buildPrefix(opts), ...args], {
    timeout: opts.timeoutMs ?? GIT_TIMEOUT,
  });
}
