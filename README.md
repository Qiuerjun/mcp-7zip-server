# MCP 7-Zip Server

[![npm version](https://img.shields.io/npm/v/mcp-7zip-server.svg)](https://www.npmjs.com/package/mcp-7zip-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)

一个基于 Model Context Protocol (MCP) 的 7-Zip 压缩文件操作服务器，采用**双引擎架构**设计。

## ✨ 核心特性

- 🔄 **双引擎架构**：同时支持内置打包引擎和系统本地引擎
- 🛡️ **安全沙盒**：解压操作限制在安全目录，防止路径遍历攻击
- 📦 **多格式支持**：7z, zip, rar, tar, gz, bz2, xz 等主流格式
- 🔐 **密码支持**：支持加密压缩和解压
- ⚡ **智能探测**：自动检测并选择可用的 7-Zip 引擎

## 🚀 快速开始

### 模式 A：开箱即用版（推荐小白）

由于使用了 `optionalDependencies`，默认 `npx` 会自动下载并使用内置的 7-Zip 引擎，无需额外配置。

**Claude Desktop 配置** (`~/Library/Application Support/Claude/claude_desktop_config.json` 或 `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "7zip": {
      "command": "npx",
      "args": ["-y", "mcp-7zip-server"]
    }
  }
}
```

**Cursor 配置** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "7zip": {
      "command": "npx",
      "args": ["-y", "mcp-7zip-server"]
    }
  }
}
```

### 模式 B：轻量化极速版（推荐极客）

如果你已经安装了系统 7-Zip，可以跳过下载内置引擎，使用更轻量的安装方式：

```bash
npm install -g mcp-7zip-server --no-optional
```

**Claude Desktop 配置**:

```json
{
  "mcpServers": {
    "7zip": {
      "command": "mcp-7zip-server",
      "env": {
        "USE_SYSTEM_7ZIP": "true"
      }
    }
  }
}
```

**Cursor 配置**:

```json
{
  "mcpServers": {
    "7zip": {
      "command": "mcp-7zip-server",
      "env": {
        "USE_SYSTEM_7ZIP": "true"
      }
    }
  }
}
```

## 📋 环境变量

| 环境变量 | 说明 | 默认值 | 示例 |
|---------|------|--------|------|
| `SEVEN_ZIP_PATH` | 手动指定 7-Zip 可执行文件的绝对路径 | - | `/usr/local/bin/7z` 或 `C:\Program Files\7-Zip\7z.exe` |
| `USE_SYSTEM_7ZIP` | 强制使用系统安装的 7-Zip | `false` | `true` 或 `1` |
| `MCP_7ZIP_SANDBOX` | 自定义沙盒目录路径 | `~/.mcp-7zip-sandbox` | `/path/to/sandbox` |

### 引擎优先级

服务器按以下优先级选择 7-Zip 引擎：

1. **最高优先级**：`SEVEN_ZIP_PATH` 环境变量指定的路径
2. **次高优先级**：`USE_SYSTEM_7ZIP=true` 强制使用系统 7-Zip
3. **默认行为**：尝试内置引擎 → 降级到系统 7-Zip

## 🔧 MCP Tools

### `list_archive`

列出压缩文件中的内容。

**参数：**
- `archivePath` (必填)：压缩文件的绝对路径
- `password` (可选)：解压密码

**示例：**
```json
{
  "archivePath": "/path/to/archive.7z"
}
```

### `extract_archive`

解压文件到沙盒目录。

**参数：**
- `archivePath` (必填)：压缩文件的绝对路径
- `targetDir` (可选)：解压目标目录（相对于沙盒目录）
- `password` (可选)：解压密码
- `overwrite` (可选)：覆盖策略 - `overwrite`（默认）、`skip`、`rename`

**示例：**
```json
{
  "archivePath": "/path/to/archive.zip",
  "targetDir": "my-extracted-files",
  "overwrite": "skip"
}
```

### `create_archive`

创建压缩文件。

**参数：**
- `archivePath` (必填)：输出压缩文件的路径
- `files` (必填)：要压缩的文件/目录路径列表
- `format` (可选)：压缩格式 - `7z`（默认）、`zip`、`tar`、`gz`、`bz2`、`xz`
- `password` (可选)：加密密码
- `compressionLevel` (可选)：压缩级别 0-9（默认 5）

**示例：**
```json
{
  "archivePath": "/path/to/output.7z",
  "files": ["/path/to/file1.txt", "/path/to/folder"],
  "format": "7z",
  "compressionLevel": 9
}
```

## 🛡️ 安全特性

### 防命令注入
- 使用 `execFile` 而非 `exec`，参数以数组形式传递
- 不使用 shell 执行，防止命令注入攻击

### 防路径遍历（沙盒机制）
- 解压操作强制限制在沙盒目录（默认 `~/.mcp-7zip-sandbox`）
- 压缩时校验输入路径，禁止读取 `/etc`、`~/.ssh` 等敏感目录
- 可通过 `MCP_7ZIP_SANDBOX` 环境变量自定义沙盒位置

### 防上下文爆炸
- `list_archive` 输出超过 4000 字符自动截断
- 截断时显示文件总数统计，提示使用过滤条件

## 📦 支持的格式

| 格式 | 读取 | 写入 | 说明 |
|------|------|------|------|
| 7z | ✅ | ✅ | 高压缩比，推荐 |
| zip | ✅ | ✅ | 通用兼容 |
| rar | ✅ | ❌ | 只读支持 |
| tar | ✅ | ✅ | Unix 归档 |
| gz | ✅ | ✅ | gzip 压缩 |
| bz2 | ✅ | ✅ | bzip2 压缩 |
| xz | ✅ | ✅ | xz 压缩 |

## 🔍 故障排除

### "未找到 7-Zip 引擎" 错误

**解决方案（任选其一）：**

1. **安装系统 7-Zip**
   - Windows: https://www.7-zip.org/download.html
   - macOS: `brew install p7zip`
   - Linux: `sudo apt install p7zip-full` 或 `sudo yum install p7zip`

2. **重新安装内置引擎**
   ```bash
   npm install -g mcp-7zip-server
   ```

3. **手动指定路径**
   ```json
   {
     "env": {
       "SEVEN_ZIP_PATH": "/path/to/7z"
     }
   }
   ```

### 权限问题

如果遇到权限错误，确保沙盒目录有写入权限：

```bash
mkdir -p ~/.mcp-7zip-sandbox
chmod 755 ~/.mcp-7zip-sandbox
```

## 🏗️ 开发

```bash
# 克隆仓库
git clone https://github.com/your-username/mcp-7zip-server.git
cd mcp-7zip-server

# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 构建
npm run build

# 运行
npm start
```

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 🙏 致谢

- [7-Zip](https://www.7-zip.org/) - 强大的开源压缩软件
- [7zip-bin](https://github.com/develar/7zip-bin) - 7-Zip 预编译二进制文件
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP 协议规范
