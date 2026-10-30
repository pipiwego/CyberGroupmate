import { spawn, type ChildProcess } from "node:child_process";
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
 */
export class DshCliLauncher implements HarnessLauncher {
    readonly name = "dsh";
    private dshPath: string;
    private dshHome?: string;
    private apiKey?: string;
    private provider: string;

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
