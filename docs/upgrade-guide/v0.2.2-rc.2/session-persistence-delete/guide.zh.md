---
kind: upgrade-guide
description: "自定义 Session 持久化后端必须实现彻底删除及其清理通知。"
---

# Session 持久化删除

[English](guide.md) | 中文

## 变更

`SessionPersistence` 新增抽象方法 `delete(id): Promise<boolean>`。自定义子类需要实现该方法才能编译。随产品交付的 JSONL 后端已实现，应用用户无需更改配置或迁移数据。

## 迁移

1. 在自定义后端中实现 `delete(id)`。拒绝活跃写入者，关闭本地读句柄，擦除全部存储版本，并返回是否存在日志；不存在的 id 为幂等空操作。
2. 擦除日志前等待 `session/deleting`，擦除后等待 `session/deleted`，重复删除时也派发通知，以便部分失败后继续完成派生数据清理。保留错误并允许重试。
3. 产品操作统一调用 `ctx.workspaceRegistry.deleteSession(id)`，完成活动检查、运行时释放和工作区清理。验证拒绝活跃写入者，并确认重启后 list、stat、open 及搜索无法返回已删除历史。
