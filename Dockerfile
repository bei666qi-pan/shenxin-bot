# 深信服智能客服 · 零依赖 Node 服务，Coolify 友好
FROM node:20-alpine
WORKDIR /app
# 仅复制必要文件（无 npm 依赖，构建快、国内网络友好）
COPY server.js knowledge.js ./
COPY public ./public
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
