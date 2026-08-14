# syntax=docker/dockerfile:1

# 飞书 Worker 独立部署镜像。
#
# Node 25 发行包已移除 Corepack（见 Node 25 release notes），干净镜像里没有
# corepack 命令——原 compose 在启动时执行 `corepack enable && corepack prepare`
# 会直接失败。这里在构建阶段用 npm 显式安装固定版本 pnpm（与根 package.json 的
# packageManager 字段、deploy/daemon/Dockerfile 的做法一致），避免每次容器启动
# 都联网安装。源码由 docker-compose.yml 在运行时挂载到 /srv/DofeAgent，本镜像
# 只负责提供 node + pnpm，不内嵌源码。
FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_registry=https://registry.npmmirror.com

RUN npm install --global pnpm@10.26.2

WORKDIR /srv/DofeAgent
