# 深信服智能客服 · Sangfor AI Customer Service

部署在 **shenxin.versecraft.cn** 的深信服科技官方风格智能客服演示。

- 前端：单页企业蓝聊天界面（零外部 CDN，国内可直连）
- 后端：零依赖 Node 服务，流式代理 **火山引擎方舟（Ark）** 大模型
- 知识库：深信服公司/产品/服务真实资料（见 `knowledge.js`）
- 未配置大模型 Key 时自动进入「演示模式」，用本地知识库应答，页面始终可用

## 本地运行
```bash
node server.js            # 演示模式（无需 Key）
ARK_API_KEY=xxx ARK_MODEL=doubao-seed-1-6-250615 node server.js   # 接入真实大模型
```
打开 http://localhost:3000

## Coolify 部署
1. New Resource → Application → 选择本仓库（Git）
2. Build Pack：**Dockerfile**
3. Ports Exposes：`3000`
4. Domains：`https://shenxin.versecraft.cn`
5. Environment Variables：填入 `ARK_API_KEY`、`ARK_MODEL`（见 `.env.example`）
6. Deploy

## 环境变量
| 变量 | 说明 |
|------|------|
| `ARK_API_KEY` | 火山引擎方舟 API Key |
| `ARK_MODEL` | 模型名或推理接入点 ID（默认 `doubao-seed-1-6-250615`）|
| `ARK_BASE_URL` | 方舟地址，默认 `https://ark.cn-beijing.volces.com/api/v3` |
| `PORT` | 服务端口，默认 `3000` |
