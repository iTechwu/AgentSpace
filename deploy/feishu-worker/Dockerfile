# syntax=docker/dockerfile:1

# 飞书 Worker 独立部署镜像。
#
# 为避免依赖 corepack（不同 Node 发行包对 corepack 的打包策略不一致，干净
# 镜像里不假设 corepack 命令可用——原 compose 启动时执行 `corepack enable &&
# corepack prepare` 会直接失败），这里在构建阶段用 npm 显式安装固定版本 pnpm
# （与根 package.json 的 packageManager 字段、deploy/daemon/Dockerfile 的做法一致），
# 避免每次容器启动都联网安装。源码由 docker-compose.yml 在运行时挂载到
# /srv/DofeAgent，本镜像只负责提供 node + pnpm，不内嵌源码。
FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_registry=https://registry.npmmirror.com

RUN npm install --global pnpm@10.26.2

WORKDIR /srv/DofeAgent
