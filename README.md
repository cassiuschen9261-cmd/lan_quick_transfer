# ⚡ LAN Quick Transfer / 局域网快传

一个面向 Windows 和局域网环境的轻量级网页文件传输工具。  
在同一个 Wi-Fi / 局域网内，电脑、手机、平板打开同一个地址即可发送文字、传文件、传文件夹、扫码快连，无需登录、无需云端中转。

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20LAN-blue)
![Status](https://img.shields.io/badge/Status-Active-success)

## ✨ 功能亮点

### 🚀 局域网极速传输

- 同一局域网内设备互传文件和文字
- 支持手机、电脑、平板浏览器访问
- 文件通过本机局域网直传，不依赖第三方云服务
- 支持中文文件名和文件夹相对路径

### 📁 文件 / 文件夹上传

- 支持单文件、多文件、文件夹上传
- 支持拖拽上传
- 支持粘贴截图直接上传
- 大文件采用分片上传
- 支持断点续传
- 网络波动时自动重试分片

### 📊 上传体验增强

- 总上传进度条
- 单文件上传任务列表
- 每个文件显示：
  - 文件名
  - 上传进度
  - 已上传 / 总大小
  - 上传速度
  - 剩余时间
  - 当前状态
- 失败任务保留在列表中，可单独点击 `重试`

### 📥 下载体验增强

- 下载任务面板
- 下载进度、速度、剩余时间
- 下载完成 / 失败状态展示
- 文件下载链接自动跟踪

### 📱 快速连接

- 首页显示推荐访问地址
- 一键复制快连地址
- 快连弹窗显示：
  - 可用连接地址
  - 二维码
  - 当前在线设备
  - 复制全部地址
- 二维码由后端本地生成 SVG，不依赖外部网络

### 🖥️ Windows 托盘 / 后台运行

- 一键启动托盘模式
- Windows 通知区域托盘图标
- 右键菜单支持：
  - 查看服务状态
  - 查看守护进程状态
  - 查看开机自启状态
  - 显示本机快连地址
  - 打开快连页面
  - 复制快连地址
  - 启动 / 守护后台服务
  - 停止后台服务
  - 启用 / 关闭开机自启
  - 打开状态面板
- 防止重复启动多个托盘图标

### 🧹 存储管理

- 查看上传文件、临时分片、聊天历史占用
- 支持按天清理
- 支持容量上限自动清理
- 支持手动清理上传文件和聊天记录

### 🖥️ 设备管理

- 自动识别局域网在线设备
- 支持按 IP 设置设备备注
- 消息中展示设备名称，方便区分发送方

## 🖼️ 界面预览

> 当前仓库暂未附带截图。运行后可在浏览器打开首页查看完整界面。

- 主界面：聊天记录、文件卡片、上传入口、快连地址
- 快连弹窗：二维码、地址列表、在线设备
- 上传任务列表：单文件进度、速度、剩余时间、失败重试
- Windows 托盘：后台运行、复制快连地址、开机自启

## 🧰 技术栈

- **后端**：Node.js 18+、Express 5
- **上传处理**：Multer、分片上传、断点续传
- **实时同步**：Server-Sent Events
- **前端**：原生 HTML / CSS / JavaScript
- **Windows 辅助能力**：PowerShell、Batch、HTA、VBScript
- **自动化测试**：JSDOM、Playwright Core / Edge

## 📦 安装方式

### 方式一：下载安装包（推荐）

前往 [Releases](https://github.com/cassiuschen9261-cmd/lan_quick_transfer/releases) 页面下载最新版本：

- `LANQuickTransfer-x.x.x.msi` - Windows MSI 安装包
- `LANQuickTransfer-x.x.0-setup.exe` - Windows EXE 安装包

安装包内置 Node.js 运行时和全部依赖，无需额外安装 Node.js，开箱即用。

### 方式二：从源码运行

请先安装 **Node.js 18 或更高版本**。

```bash
npm install
```

## 📦 从源码安装依赖

请先安装 **Node.js 18 或更高版本**。

```bash
npm install
```

## 🚀 启动方式

### 方式一：Windows 菜单启动

双击：

```text
start_server.bat
```

菜单中可选择：

- `Start visible console`：前台控制台启动
- `Start silent background mode`：静默后台启动
- `Start tray background mode`：托盘后台启动
- `Stop background server`：停止后台服务
- `Show server status`：查看服务状态
- `Open status panel`：打开状态面板

### 方式二：直接启动托盘模式

双击：

```text
start_server_tray.bat
```

或运行：

```bash
start_server.bat tray
```

启动后在 Windows 右下角通知区域找到托盘图标，右键即可管理服务和复制快连地址。

### 方式三：npm 启动

```bash
npm start
```

默认会监听：

```text
0.0.0.0:18082
```

如果端口被占用，程序会自动寻找可用端口。

## 📱 手机 / 其他设备如何连接

1. 确保设备在同一个 Wi-Fi / 局域网内
2. 在电脑上启动服务
3. 打开首页或托盘菜单中的快连地址
4. 手机扫码或输入局域网地址
5. 开始发送文字或文件

常见地址形式：

```text
http://192.168.x.x:18082
```

## ⚙️ 常用命令

```bash
npm start
```

启动服务。

```bash
npm test
```

运行完整回归测试。

```bash
npm run test:smoke
```

运行轻量烟雾测试。

```bash
npm run test:browser
```

运行真实浏览器测试。

```bash
start_server.bat tray
```

启动 Windows 托盘后台模式。

```bash
start_server.bat stop
```

停止后台服务。

```bash
start_server.bat status
```

查看服务状态和可用访问地址。

## 📂 项目结构

```text
lan_quick_transfer/
├─ server.js                         # Express 后端服务
├─ 轻量局域网快传.html                 # 单页前端界面
├─ start_server.bat                  # Windows 启动菜单
├─ start_server_tray.bat             # Windows 托盘启动入口
├─ start_server.ps1                  # PowerShell 前台启动脚本
├─ scripts/
│  ├─ tray_agent.ps1                 # Windows 托盘代理
│  ├─ silent_guardian.ps1            # 后台守护进程
│  ├─ start_server_hidden.ps1        # 静默后台启动
│  ├─ stop_server.ps1                # 停止后台服务
│  ├─ show_server_status.ps1         # 查看状态
│  ├─ server_status.hta              # Windows 状态面板
│  └─ run_regression_tests.ps1       # 回归测试入口
├─ data/                             # 本地配置、状态、聊天历史
├─ uploads/                          # 上传文件存储目录
├─ package.json
└─ README.md
```

## 🔒 隐私和安全说明

- 文件默认只保存在本机 `uploads/` 目录
- 聊天历史和配置默认保存在本机 `data/` 目录
- 不需要账号，不上传到第三方云端
- 请只在可信局域网中使用
- 如需限制陌生设备访问，后续可以扩展访问码 / PIN 功能

## 🧪 测试

项目包含自动化回归测试：

```bash
npm test
```

测试覆盖内容包括：

- 双页面消息同步
- 清空记录同步
- 设备备注同步
- 二维码快连
- 存储策略保存
- 真实文件上传
- 上传任务列表
- 下载任务跟踪
- 清理文件同步

## 🛠️ 适用场景

- 手机和电脑之间快速传文件
- 局域网内多台电脑临时互传资料
- 没有微信 / QQ / 网盘时传文件
- 不想经过云端的本地文件共享
- 临时会议、实验室、办公室内快速共享文件

## ⏱ 文件过期与批量下载（v1.1.0 新增）

- 上传时可选择文件保留时长：1 小时 / 1 天 / 7 天 / 永久
- 过期文件自动清理，同时移除聊天记录中的对应消息
- 多选文件批量打包下载为 ZIP（服务端生成，最多 200 个文件）
- 聊天消息列表支持文件搜索 / 筛选
- 图片附件支持灯箱预览
- 下载队列支持全部暂停 / 全部继续 / 全部删除

## 🧭 后续可改进方向

- 移动端界面进一步优化
- 图片灯箱预览
- 文件搜索和筛选
- 可选访问码 / PIN
- PWA 添加到桌面
- 多文件打包下载

## 📄 License

ISC
