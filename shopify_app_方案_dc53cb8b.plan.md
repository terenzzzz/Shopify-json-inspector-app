---
name: Shopify App 方案
overview: 把现有纯前端 JSON Inspector 演进为 Shopify App，让原图下载从“用户手填 Admin Token + 本地代理”变成“安装 App 后通过授权安全调用 Admin API”。整体上更适合长期使用和分发，但初期建议保留现有静态工具作为独立模式。
todos:
  - id: choose-app-scope
    content: 确定 App 的 MVP 范围：只做上传 JSON 原图下载，还是同时支持读取店铺主题模板
    status: pending
  - id: scaffold-shopify-app
    content: 创建 Shopify App 项目，配置 OAuth、Admin API scopes 和嵌入式后台页面
    status: pending
  - id: migrate-inspector-ui
    content: 迁移现有 JSON 解析、图片扫描、统计和 ZIP 下载 UI 到 App 前端
    status: pending
  - id: replace-admin-proxy
    content: 用 App 后端接口替换本地 Admin 代理，安全调用 Admin GraphQL 解析 originalSource
    status: pending
  - id: preserve-static-mode
    content: 保留 CDN 模式和现有静态工具能力，作为无需安装 App 的轻量入口
    status: pending
isProject: false
---

# Shopify App 化方案

## 结论

建议做成 Shopify App，前提是你的目标是给自己或其他商家长期、稳定地使用“模板 JSON 分析 + 原图批量下载”。

当前工具已经具备核心分析能力，主要瓶颈在原图下载链路：[`utils/downloadImages.js`](/Users/terenzzzz/Desktop/shopify-json-inspector/utils/downloadImages.js) 需要 `mode: 'original'`、店铺域名、Admin Token 和本地代理；[`server/admin-proxy.mjs`](/Users/terenzzzz/Desktop/shopify-json-inspector/server/admin-proxy.mjs) 只是把浏览器请求转发到 Admin GraphQL。这对开发者可用，但对普通使用者不够顺滑，也不适合让用户手动暴露长期 Admin Token。

## 推荐方向

- 将现有 UI 迁移成嵌入式 Shopify App 页面，保留“上传/粘贴 template JSON 分析”的低门槛体验。
- 用 Shopify OAuth 安装授权替代手填 `Admin Token`，后端保存店铺 access token，并只申请原图解析所需的最小权限。
- 将当前本地代理能力升级为 App 后端 API，例如 `/api/original-sources`，由后端调用 Admin GraphQL `files` 查询并返回原图签名 URL 或直接代下载。
- 前端下载流程继续复用现有 ZIP 打包逻辑，先把 Admin 相关调用从 [`utils/shopifyAdmin.js`](/Users/terenzzzz/Desktop/shopify-json-inspector/utils/shopifyAdmin.js) 抽象成可切换的数据源。

## 建议的 MVP

1. 先搭一个 Shopify App 壳：嵌入式 Admin 页面、OAuth、session/token 存储。
2. 把现有 `index.html` / `main.js` 的页面能力迁移进 App 前端。
3. 新增后端接口替代 `server/admin-proxy.mjs`，接收文件名列表，返回 `originalSource` 映射。
4. 保留 CDN 下载作为 fallback，原图下载作为安装 App 后的增强能力。
5. 最后再考虑从 Theme API 自动读取模板 JSON，减少用户手动上传。

## 关键取舍

做成 App 的体验会更好：不用用户复制 token、不用运行本地代理、店铺上下文自动识别，也更容易扩展成“读取主题模板、扫描资源、批量导出”的完整工作流。

代价是复杂度明显上升：需要后端、OAuth、token 存储、权限申请、部署、App 安装流程。如果只是你自己临时迁移资源，当前工具 + 本地代理已经够用；如果你想把它变成可复用产品或内部工具，App 化更直接。