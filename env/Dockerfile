FROM node:20-slim AS build
WORKDIR /app
# better-sqlite3 是原生模块：目标平台无预编译包（或预编译包下载失败）时 npm 会
# 回退到 node-gyp 源码构建，依赖 python3 / make / g++——slim 镜像默认不带，
# 装在构建阶段即可，最终镜像保持精简
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000
# better-sqlite3 已在构建阶段编译（或拿到预编译包），随 node_modules 一并复制，
# 运行阶段与构建阶段同为 node:20-slim（相同 Node ABI 与 glibc），可直接加载
COPY --from=build /app/node_modules ./node_modules
COPY server ./server
COPY client ./client
COPY test ./test
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/projects').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
