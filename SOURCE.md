# 来源与分发范围

本仓库是维护版本的源码快照，使用新的Git历史保存；不是整个原始工作目录或私人运行环境的备份。

## 项目来源

- 基础项目：[pinganbbOvO/ai-companion-kit](https://github.com/pinganbbOvO/ai-companion-kit)，记录的基础提交为 `cf7f8eb`。根目录MIT许可证中的AI Companion Kit contributors署名保持原样。
- 快照包括后续维护的DSH伴侣插件、账号隔离、记忆与账本、平台浏览、容量保护及正式桌面恢复入口。
- 原有包内README、角色来源说明和许可证继续保留。Git提交作者只代表本次整理，不替代上游代码作者。

## 第三方资源

- `vendor/bili-readonly`：固定来源的只读MCP源码、补丁、两份MIT许可和PROVENANCE；功能与实际账号绑定分别验收。
- `packages/dsh-dafeiyu/src/social/bili-cli-NOTICE.txt`：B站登录响应兼容部分的MIT来源说明。
- `vendor/control-plugins/anionex-helper-scalar`：MIT Swift源码、修补与构建说明；不附本机编译及签名的helper。
- `vendor/control-plugins/dsh-ego-browser-0.9.2-dfy.1.tgz`：经过归档成员检查的MIT JavaScript插件分发包，保留运行代码与许可证原始字节；仅将构建文档中的个人机器路径归一为通用路径，并重新计算分发包及依赖哈希；不包含浏览器、可选FFmpeg或官方DSH核心二进制。它是历史通用控制插件依赖，不等于当前抖音浏览采用的原生Ego适配。包内LICENSE及THIRD_PARTY_NOTICES同时单独保留以便审查。
- `patches/biliup-receipt`：针对固定上游版本的回执补丁；对应MIT许可与来源记录随目录保留。

## 明确排除

真实账号配置、Cookie和token、私人角色卡与记忆、登录profile、账本、运行日志、AX树和截图、现场报告原始数据、node_modules、官方DSH的ASAR/核心实现、本机Mach-O构建产物，以及来源/许可不足的历史bridge与SnowLuma归档补丁均不在快照中。

此仓库不会移动或重置正在运行的维护目录，也不把快照推送等同于部署、账号授权、业务发布或开启自主活动。

`vendor/control-plugins/SHA256.json`中被刻意排除的helper二进制条目只保留为历史构建摘要；该文件不表示源码快照附带所有历史产物。请从许可齐全的源码在本机明确构建，不复制运行机器的二进制。
