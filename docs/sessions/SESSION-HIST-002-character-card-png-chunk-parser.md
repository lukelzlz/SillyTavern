---
id: SESSION-HIST-002
title: 历史会话归档：角色卡导入失败 (Error importing character) 与 PNG tEXt 块规范解析
date: 2026-08-19
type: historical_archive
original_source: Antigravity (a858d232-f1a0-4db1-bdc1-d1a3adee368a)
---

# 历史推演归档：角色卡导入失败与 PNG 元数据规范深度排查

## 1. 历史问题现象与排查背景
- **问题现象**：用户在 SillyTavern 前端尝试导入一张从外部平台/ChatGPT 保存的角色图片时，系统弹窗报错：
  `Error importing character Error: Server returned an error: true at importCharacter (script.js:10506:1)`。
- **用户诉求**：明确报错根因，确定是角色卡损坏、图片格式不兼容还是酒馆服务端处理问题，并搞清 V2 角色卡规范的存储机制。

## 2. 曾尝试的无效路径与失败原因
- **尝试 1：怀疑是文件名或扩展名错误**：
  - 用户重命名或将后缀改为 `.png` / `.webp`，但服务端仍然拒绝解析。
- **尝试 2：误以为所有 AI 生成的 PNG 图片天生都携带角色卡信息**：
  - 直接将 Discord/ChatGPT 对话中另存为或经过国内通讯软件（如微信/QQ/某些图床）二次压缩后的图片上传，元数据已被强行剥除。

## 3. 最终落地的解决策略与架构洞见
- **根因定位 (Missing Character Metadata in PNG Chunks)**：
  - 酒馆角色卡在 PNG 格式中依赖标准的 PNG Ancillary Chunks（文本数据块）：
    - **Tavern Card V2 规范**：使用关键字 `chara`，内容为 Base64 编码的 JSON 字符串。
    - **Tavern Card V3 规范 (CCv3)**：使用关键字 `ccv3`，内容为包含 spec/spec_version 的 JSON。
  - 在 `src/endpoints/characters.js` 和 `character-card-parser.js` 中，服务端使用纯 Node 原生 Buffer / PNG 流解析器提取 PNG `tEXt` 块。
  - 若图片中不存在 `chara` 或 `ccv3` 关键字的文本块，解析函数将直接抛出异常，前端接收到 HTTP 500/400 并弹窗 `Error importing character`。
- **解决路径与避坑指南**：
  - **原始文件传输**：从 Discord 获取角色卡时，必须使用 Discord Bot 的原文件下载或 `/下载` 命令，或者网盘直接下载原图。严禁在聊天软件中“复制图片”或查看缩略图另存为。
  - **纯 JSON 兜底**：若图片元数据已损坏，可直接使用对应的角色卡 `.json` 文件导入酒馆，酒馆会自动匹配或允许上传任意头像图片。

## 4. 沉淀至部落知识库的经验条目
1. **PNG 角色卡解析核心三要素**：检查是否包含 PNG 魔数头、检查是否存在 `tEXt` 块、检查块名是否为 `chara` (V2) 或 `ccv3` (V3)。
2. **CDN 与图片反代洗数据深坑**：绝大部分公共图床与 CDN 会自动对 WebP/PNG 执行有损压缩和 metadata 剔除（stripping EXIF & Ancillary Chunks），导致角色卡失效。下载角色卡必须保持源文件无损。
