import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../core/logger.js";
import {
    buildHarnessEnv,
    getDshHome,
    writeHarnessInstructionsWithRestore,
} from "../home.js";
import type { HarnessLaunchOptions, HarnessLauncher, HarnessMcpConfig } from "../types.js";

const log = createLogger("harness-dsh");

const DEFAULT_PROVIDER = "deepseek-official";
const DEFAULT_MODEL = "deepseek-flash";

/**
 * DeepSeek Harness（dsh）启动器。
 *
 * 一次做梦 = 一次 `dsh --profile headless --json <prompt>` 进程。
 * 人格 prompt 写进 $DSH_HOME/AGENTS.md，做梦结束后还原。
 * MCP 服务器与模型通过临时 patch 文件注入，不修改用户的 profile。
 *
 * 与版本相关的硬性约束（实测于 0.2.1-rc.5，升级后必须重新核对）：
 *
 * 1. `--profile` 与 `--patch` 属于启动器选项，必须排在应用参数（`--json`、任务文本）
 *    之前。顺序颠倒会得到 `{"type":"error","message":"unknown option '--patch'"}`，
 *    进程立即以退出码 1 结束，且只有这一行输出。
 * 2. 该版本没有 `--approval-policy` 与 `--permission-mode`；官方文档写的是更新的版本。
 *    不要为了「无人值守」而传它们。实测 headless 写工作区文件不触发审批。
 * 3. `final` 事件只含 `type` 与 `text`，没有 `sessionId`；会话标识只能在开场的
 *    `session` 事件里拿。
 */
export class DshCliLauncher implements HarnessLauncher {
    readonly name = "dsh";
    private dshPath: string;
    private dshHome?: string;
    private apiKey?: string;
    private provider: string;

    /** 版本号只探一次，供日志与运行记录使用 */
    private resolvedVersion?: string;

    constructor(opts?: {
        dshPath?: string;
        dshHome?: string;
        apiKey?: string;
        provider?: string;
    }) {
        this.dshPath = opts?.dshPath?.trim() || "dsh";
        this.dshHome = opts?.dshHome?.trim() || undefined;
        this.apiKey = opts?.apiKey?.trim() || undefined;
        this.provider = opts?.provider?.trim() || DEFAULT_PROVIDER;
    }

    async start(options: HarnessLaunchOptions): Promise<ChildProcess> {
        const homeDir = getDshHome(process.env, options.harnessHome ?? this.dshHome);
        mkdirSync(homeDir, { recursive: true });

        const model = options.model?.trim() || DEFAULT_MODEL;
        const patchPath = join(options.workDir, "workspace", ".dsh-background-patch.yml");
        mkdirSync(join(options.workDir, "workspace"), { recursive: true });
        writeFileSync(patchPath, this.buildPatch(options.mcpConfig, model), "utf-8");

        // AGENTS.md 是 DSH 的用户全局指令文件，做梦结束后还原，避免影响其它会话
        const { instructionPath, restore } = writeHarnessInstructionsWithRestore(
            homeDir,
            this.name,
            options.systemPrompt,
            { ...process.env, DSH_HOME: homeDir },
        );

        // 顺序要紧：--profile / --patch 是启动器选项，必须排在应用参数（--json、prompt）之前
        const args = [
            "--profile", "headless",
            "--patch", patchPath,
            "--json",
            options.prompt,
        ];

        if (options.extraArgs) {
            // 追加在 prompt 之前，避免被当成任务文本
            args.splice(args.length - 1, 0, ...options.extraArgs);
        }

        const extraEnv: NodeJS.ProcessEnv = {
            ...options.env,
            DSH_HOME: homeDir,
            PWD: options.workDir,
        };
        if (this.apiKey) extraEnv.DEEPSEEK_API_KEY = this.apiKey;

        const version = this.detectVersion();
        if (version) log.info("dsh version", { version });

        log.info("launching dsh", {
            dsh: this.dshPath,
            model,
            provider: this.provider,
            home: homeDir,
            instructionPath,
            hasApiKey: Boolean(extraEnv.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY),
        });

        const child = spawn(this.dshPath, args, {
            cwd: options.workDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: buildHarnessEnv(process.env, extraEnv),
        });

        const cleanup = () => {
            try {
                unlinkSync(patchPath);
            } catch {
                /* patch 文件可能已被清理，忽略 */
            }
            restore();
        };
        child.once("exit", cleanup);
        child.once("error", cleanup);

        return child;
    }

    /** 读一次 `dsh --version`，失败返回 undefined（不影响做梦） */
    detectVersion(): string | undefined {
        if (this.resolvedVersion !== undefined) return this.resolvedVersion || undefined;
        try {
            const out = execFileSync(this.dshPath, ["--version"], {
                timeout: 10_000,
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            this.resolvedVersion = out.split(/\r?\n/)[0]?.trim() ?? "";
        } catch {
            this.resolvedVersion = "";
        }
        return this.resolvedVersion || undefined;
    }

    /**
     * 生成 dsh 的 patch 层。
     * - insert：挂上 CyberGroupmate 的 MCP 服务器
     * - id 覆盖：指定默认模型
     */
    private buildPatch(mcpConfig: HarnessMcpConfig, model: string): string {
        const lines: string[] = [];
        const servers = Object.entries(mcpConfig.mcpServers);

        if (servers.length > 0) {
            lines.push("- insert:");
            for (const [name, server] of servers) {
                lines.push(`    - id: mcp-${name}`);
                lines.push(`      name: "@deepseek-ai/dsh-mcp-client"`);
                lines.push("      config:");
                lines.push(`        serverName: ${yamlScalar(name)}`);
                if (server.type === "streamable-http") {
                    lines.push("        transport: streamable-http");
                    if (server.url) lines.push(`        url: ${yamlScalar(server.url)}`);
                    const headers = Object.entries(server.headers ?? {});
                    if (headers.length > 0) {
                        lines.push("        headers:");
                        for (const [key, value] of headers) {
                            lines.push(`          ${key}: ${yamlScalar(value)}`);
                        }
                    }
                } else {
                    lines.push("        transport: stdio");
                    if (server.command) lines.push(`        command: ${yamlScalar(server.command)}`);
                    if (server.args && server.args.length > 0) {
                        lines.push(`        args: [${server.args.map(yamlScalar).join(", ")}]`);
                    }
                    const env = Object.entries(server.env ?? {});
                    if (env.length > 0) {
                        lines.push("        env:");
                        for (const [key, value] of env) {
                            lines.push(`          ${key}: ${yamlScalar(value)}`);
                        }
                    }
                }
            }
        }

        lines.push("- id: agent-default-model");
        lines.push("  config:");
        lines.push(`    provider: ${yamlScalar(this.provider)}`);
        lines.push(`    model: ${yamlScalar(model)}`);
        lines.push("");

        return lines.join("\n");
    }
}

/** 输出安全的 YAML 标量。含特殊字符时用双引号并转义 */
function yamlScalar(value: string): string {
    const text = String(value);
    if (/^[A-Za-z0-9_./:@-]+$/.test(text) && !/^(true|false|null|~)$/i.test(text)) {
        return text;
    }
    return JSON.stringify(text);
}
