#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, isAbsolute, normalize } from "node:path";

const execFileAsync = promisify(execFile);

// ============================================================================
// 双引擎架构：7-Zip 路径探测逻辑
// ============================================================================

let cachedSevenZipPath: string | null = null;

/**
 * 获取 7-Zip 可执行文件路径（双引擎优先级探测）
 *
 * 优先级顺序：
 * 1. 环境变量 SEVEN_ZIP_PATH（手动指定）
 * 2. 环境变量 USE_SYSTEM_7ZIP=true（强制使用系统）
 * 3. 内置引擎 7zip-bin（默认行为，优雅降级到系统）
 */
async function get7ZipPath(): Promise<string> {
  // 返回缓存的路径
  if (cachedSevenZipPath) {
    return cachedSevenZipPath;
  }

  // 最高优先级：手动指定路径
  const manualPath = process.env.SEVEN_ZIP_PATH;
  if (manualPath) {
    try {
      await access(manualPath);
      cachedSevenZipPath = manualPath;
      console.error(`[mcp-7zip] 使用手动指定路径: ${manualPath}`);
      return manualPath;
    } catch {
      throw new Error(
        `环境变量 SEVEN_ZIP_PATH 指定的路径不存在或无法访问: ${manualPath}`
      );
    }
  }

  // 次高优先级：强制使用系统 7-Zip
  const useSystem = process.env.USE_SYSTEM_7ZIP;
  if (useSystem === "true" || useSystem === "1") {
    const systemPath = await findSystem7Zip();
    if (systemPath) {
      cachedSevenZipPath = systemPath;
      console.error(`[mcp-7zip] 使用系统 7-Zip: ${systemPath}`);
      return systemPath;
    }
    throw new Error(
      "环境变量 USE_SYSTEM_7ZIP=true，但系统未安装 7-Zip。\n" +
        "请安装 7-Zip (https://www.7-zip.org/) 或移除 USE_SYSTEM_7ZIP 环境变量以使用内置引擎。"
    );
  }

  // 默认行为：尝试内置引擎，优雅降级到系统
  try {
    const sevenZipBin = await import("7zip-bin");
    const binPath = sevenZipBin.path7za;
    if (binPath) {
      try {
        await access(binPath);
        cachedSevenZipPath = binPath;
        console.error(`[mcp-7zip] 使用内置引擎: ${binPath}`);
        return binPath;
      } catch {
        // 二进制文件不存在，继续降级
      }
    }
  } catch {
    // 模块导入失败（用户跳过了 optionalDependencies），继续降级
  }

  // 最终降级：尝试系统 7-Zip
  const systemPath = await findSystem7Zip();
  if (systemPath) {
    cachedSevenZipPath = systemPath;
    console.error(`[mcp-7zip] 使用系统 7-Zip (降级): ${systemPath}`);
    return systemPath;
  }

  // 所有途径都失败
  throw new Error(
    "未找到 7-Zip 引擎。\n" +
      "解决方案（任选其一）：\n" +
      "  1. 安装系统 7-Zip: https://www.7-zip.org/\n" +
      "  2. 重新运行 npm install 安装内置引擎\n" +
      "  3. 设置环境变量 SEVEN_ZIP_PATH 指向 7z 可执行文件"
  );
}

/**
 * 查找系统安装的 7-Zip
 */
async function findSystem7Zip(): Promise<string | null> {
  const isWindows = process.platform === "win32";
  const candidates = isWindows
    ? [
        "7z",
        "7z.exe",
        "C:\\Program Files\\7-Zip\\7z.exe",
        "C:\\Program Files (x86)\\7-Zip\\7z.exe",
      ]
    : ["7z", "/usr/bin/7z", "/usr/local/bin/7z", "/opt/homebrew/bin/7z"];

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--help"], { timeout: 5000 });
      return candidate;
    } catch {
      // 继续尝试下一个候选
    }
  }

  return null;
}

// ============================================================================
// 沙盒安全机制
// ============================================================================

const DEFAULT_SANDBOX = join(homedir(), ".mcp-7zip-sandbox");

function getSandboxPath(): string {
  return normalize(process.env.MCP_7ZIP_SANDBOX || DEFAULT_SANDBOX);
}

/**
 * 确保沙盒目录存在
 */
async function ensureSandbox(): Promise<string> {
  const sandbox = getSandboxPath();
  await mkdir(sandbox, { recursive: true });
  return sandbox;
}

/**
 * 验证路径是否在沙盒内（防路径遍历）
 */
function isPathInSandbox(targetPath: string, sandbox: string): boolean {
  const resolvedTarget = normalize(resolve(targetPath));
  const resolvedSandbox = normalize(resolve(sandbox));
  return resolvedTarget.startsWith(resolvedSandbox + "\\") ||
    resolvedTarget.startsWith(resolvedSandbox + "/") ||
    resolvedTarget === resolvedSandbox;
}

/**
 * 验证路径是否为敏感目录（防读取敏感文件）
 */
function isSensitivePath(filePath: string): boolean {
  const normalized = normalize(filePath).toLowerCase();
  const sensitivePatterns = [
    "/etc/",
    "/etc/passwd",
    "/etc/shadow",
    "/.ssh/",
    "/.gnupg/",
    "/.aws/",
    "/.env",
    "c:\\windows\\system32",
    "c:\\users\\",
    "/root/",
    "/home/",
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/.env",
  ];

  // 获取用户主目录下的敏感路径
  const home = homedir().toLowerCase();
  const homeSensitivePaths = [
    `${home}/.ssh`,
    `${home}/.gnupg`,
    `${home}/.aws`,
    `${home}/.env`,
    `${home}\\.ssh`,
    `${home}\\.gnupg`,
    `${home}\\.aws`,
    `${home}\\.env`,
  ];

  return (
    sensitivePatterns.some((pattern) => normalized.includes(pattern)) ||
    homeSensitivePaths.some((path) => normalized.includes(path.toLowerCase()))
  );
}

/**
 * 规范化并验证解压目标路径
 */
function resolveExtractPath(targetDir: string, sandbox: string): string {
  const resolved = isAbsolute(targetDir)
    ? normalize(targetDir)
    : normalize(join(sandbox, targetDir));

  if (!isPathInSandbox(resolved, sandbox)) {
    throw new Error(
      `安全错误：解压目标路径必须在沙盒目录内。\n` +
        `沙盒目录: ${sandbox}\n` +
        `目标路径: ${resolved}\n` +
        `提示：使用相对路径或设置 MCP_7ZIP_SANDBOX 环境变量更改沙盒位置。`
    );
  }

  return resolved;
}

/**
 * 验证压缩输入路径（防止读取敏感目录）
 */
function validateArchiveInputPath(filePath: string): void {
  if (isSensitivePath(filePath)) {
    throw new Error(
      `安全错误：拒绝读取敏感路径: ${filePath}\n` +
        `禁止压缩系统目录、SSH 密钥、环境变量等敏感文件。`
    );
  }
}

// ============================================================================
// 7-Zip 命令执行器
// ============================================================================

interface SevenZipResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * 安全执行 7-Zip 命令（使用 execFile 防命令注入）
 */
async function exec7Zip(args: string[]): Promise<SevenZipResult> {
  const sevenZipPath = await get7ZipPath();

  try {
    const { stdout, stderr } = await execFileAsync(sevenZipPath, args, {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      timeout: 60000, // 60 秒超时
      windowsHide: true,
    });

    return {
      success: true,
      stdout: stdout || "",
      stderr: stderr || "",
      exitCode: 0,
    };
  } catch (error: any) {
    return {
      success: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      exitCode: error.code || 1,
    };
  }
}

// ============================================================================
// Zod Schema 定义
// ============================================================================

const ListArchiveSchema = z.object({
  archivePath: z.string().describe("压缩文件的绝对路径"),
  password: z.string().optional().describe("解压密码（如果加密）"),
});

const ExtractArchiveSchema = z.object({
  archivePath: z.string().describe("压缩文件的绝对路径"),
  targetDir: z
    .string()
    .optional()
    .describe("解压目标目录（相对于沙盒目录，默认为沙盒根目录）"),
  password: z.string().optional().describe("解压密码（如果加密）"),
  overwrite: z
    .enum(["overwrite", "skip", "rename"])
    .optional()
    .default("overwrite")
    .describe("文件覆盖策略：overwrite（覆盖）、skip（跳过）、rename（重命名）"),
});

const CreateArchiveSchema = z.object({
  archivePath: z.string().describe("输出压缩文件的路径"),
  files: z.array(z.string()).min(1).describe("要压缩的文件/目录路径列表"),
  format: z
    .enum(["7z", "zip", "tar", "gz", "bz2", "xz"])
    .optional()
    .default("7z")
    .describe("压缩格式"),
  password: z.string().optional().describe("加密密码"),
  compressionLevel: z
    .number()
    .int()
    .min(0)
    .max(9)
    .optional()
    .default(5)
    .describe("压缩级别 (0=存储, 9=极限压缩)"),
});

// ============================================================================
// MCP Server 实现
// ============================================================================

const server = new Server(
  {
    name: "mcp-7zip-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 列出可用工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_archive",
        description:
          "列出压缩文件中的内容（支持 7z, zip, rar, tar, gz 等格式）",
        inputSchema: {
          type: "object",
          properties: {
            archivePath: {
              type: "string",
              description: "压缩文件的绝对路径",
            },
            password: {
              type: "string",
              description: "解压密码（如果加密）",
            },
          },
          required: ["archivePath"],
        },
      },
      {
        name: "extract_archive",
        description: "解压文件到指定目录（默认解压到沙盒目录）",
        inputSchema: {
          type: "object",
          properties: {
            archivePath: {
              type: "string",
              description: "压缩文件的绝对路径",
            },
            targetDir: {
              type: "string",
              description: "解压目标目录（相对于沙盒目录）",
            },
            password: {
              type: "string",
              description: "解压密码（如果加密）",
            },
            overwrite: {
              type: "string",
              enum: ["overwrite", "skip", "rename"],
              description: "文件覆盖策略",
              default: "overwrite",
            },
          },
          required: ["archivePath"],
        },
      },
      {
        name: "create_archive",
        description: "创建压缩文件（支持 7z, zip, tar, gz, bz2, xz 格式）",
        inputSchema: {
          type: "object",
          properties: {
            archivePath: {
              type: "string",
              description: "输出压缩文件的路径",
            },
            files: {
              type: "array",
              items: { type: "string" },
              description: "要压缩的文件/目录路径列表",
            },
            format: {
              type: "string",
              enum: ["7z", "zip", "tar", "gz", "bz2", "xz"],
              description: "压缩格式",
              default: "7z",
            },
            password: {
              type: "string",
              description: "加密密码",
            },
            compressionLevel: {
              type: "number",
              description: "压缩级别 (0-9)",
              default: 5,
            },
          },
          required: ["archivePath", "files"],
        },
      },
    ],
  };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_archive":
        return await handleListArchive(args);
      case "extract_archive":
        return await handleExtractArchive(args);
      case "create_archive":
        return await handleCreateArchive(args);
      default:
        throw new Error(`未知工具: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `错误: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// ============================================================================
// 工具处理函数
// ============================================================================

/**
 * 列出压缩文件内容
 */
async function handleListArchive(args: unknown) {
  const { archivePath, password } = ListArchiveSchema.parse(args);

  const sevenZipArgs = ["l", "-slt", archivePath];
  if (password) {
    sevenZipArgs.push(`-p${password}`);
  }

  const result = await exec7Zip(sevenZipArgs);

  if (!result.success) {
    throw new Error(`列出压缩文件失败: ${result.stderr}`);
  }

  let output = result.stdout;

  // 防上下文爆炸：超过 4000 字符截断
  const MAX_OUTPUT_LENGTH = 4000;
  if (output.length > MAX_OUTPUT_LENGTH) {
    // 统计文件数量
    const fileCount = (output.match(/^Path = /gm) || []).length;

    output =
      output.substring(0, MAX_OUTPUT_LENGTH) +
      `\n\n... [输出截断] 共 ${fileCount} 个文件/目录\n` +
      `提示：使用更具体的路径或过滤条件来查看特定内容。`;
  }

  return {
    content: [
      {
        type: "text",
        text: output,
      },
    ],
  };
}

/**
 * 解压文件
 */
async function handleExtractArchive(args: unknown) {
  const { archivePath, targetDir, password, overwrite } =
    ExtractArchiveSchema.parse(args);

  const sandbox = await ensureSandbox();
  const extractPath = resolveExtractPath(targetDir || ".", sandbox);

  // 确保目标目录存在
  await mkdir(extractPath, { recursive: true });

  const sevenZipArgs = ["x", archivePath, `-o${extractPath}`];

  // 覆盖策略
  switch (overwrite) {
    case "overwrite":
      sevenZipArgs.push("-aoa");
      break;
    case "skip":
      sevenZipArgs.push("-aos");
      break;
    case "rename":
      sevenZipArgs.push("-aou");
      break;
  }

  if (password) {
    sevenZipArgs.push(`-p${password}`);
  }

  const result = await exec7Zip(sevenZipArgs);

  if (!result.success) {
    throw new Error(`解压失败: ${result.stderr}`);
  }

  return {
    content: [
      {
        type: "text",
        text: `✅ 解压成功！\n\n输出目录: ${extractPath}\n\n${result.stdout}`,
      },
    ],
  };
}

/**
 * 创建压缩文件
 */
async function handleCreateArchive(args: unknown) {
  const { archivePath, files, format, password, compressionLevel } =
    CreateArchiveSchema.parse(args);

  // 验证所有输入路径
  for (const file of files) {
    validateArchiveInputPath(file);
  }

  // 确定输出格式
  let formatFlag: string;
  switch (format) {
    case "7z":
      formatFlag = "7z";
      break;
    case "zip":
      formatFlag = "zip";
      break;
    case "tar":
      formatFlag = "tar";
      break;
    case "gz":
      formatFlag = "gzip";
      break;
    case "bz2":
      formatFlag = "bzip2";
      break;
    case "xz":
      formatFlag = "xz";
      break;
    default:
      formatFlag = "7z";
  }

  const sevenZipArgs = [
    "a",
    `-t${formatFlag}`,
    `-mx=${compressionLevel}`,
    archivePath,
    ...files,
  ];

  if (password) {
    sevenZipArgs.push(`-p${password}`);
    // 对 7z 格式启用文件名加密
    if (format === "7z") {
      sevenZipArgs.push("-mhe=on");
    }
  }

  const result = await exec7Zip(sevenZipArgs);

  if (!result.success) {
    throw new Error(`创建压缩文件失败: ${result.stderr}`);
  }

  // 获取压缩后文件大小
  let fileSize = "未知";
  try {
    const stats = await stat(archivePath);
    fileSize = formatBytes(stats.size);
  } catch {
    // 忽略错误
  }

  return {
    content: [
      {
        type: "text",
        text: `✅ 压缩成功！\n\n输出文件: ${archivePath}\n格式: ${format}\n大小: ${fileSize}\n\n${result.stdout}`,
      },
    ],
  };
}

// ============================================================================
// 工具函数
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// ============================================================================
// 启动服务器
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-7zip] MCP 7-Zip 服务器已启动");
}

main().catch((error) => {
  console.error("[mcp-7zip] 启动失败:", error);
  process.exit(1);
});
