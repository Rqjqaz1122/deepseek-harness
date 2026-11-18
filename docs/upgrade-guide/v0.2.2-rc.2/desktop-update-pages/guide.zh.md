---
kind: upgrade-guide
description: 未签名 Desktop 安装包需要已发布的 GitHub Pages 渠道清单，不再查询 GitHub Releases API。
---

# GitHub Pages 上的 Desktop 更新清单

[English](guide.md) | 中文

## 变更

配置 `dshDesktopManualUpdateRepository` 的未签名 Desktop 包改为检查 Pages 静态清单，不再请求 GitHub Releases REST API。仓库维护者必须先部署两个渠道文件，再分发新版客户端。客户端会拒绝缺失、无效或不匹配的清单，不会报告已是最新版本。安装仍通过 GitHub Release 页面完成。

## 迁移

1. 按照 [GitHub Release 自动打包](../../../../apps/desktop/packaging/README.zh.md#github-release-automation) 保留仓库默认 Pages 站点，并启用 Actions 部署。
2. 从更新后的源码运行 **Deploy GitHub Pages**，选择 `site=desktop-updates`。验证 `updates/stable.json` 和 `updates/nightly.json` 可以访问；开发版清单应包含已上传的兼容安装包。
3. 分发包含本次修改的客户端。现有安装保留 API 检查逻辑，需要先手动升级一次。后续 `desktop-v<version>` 发布会在安装包上传成功后发布清单；编辑或删除已有 Release 后需要手动刷新清单。
