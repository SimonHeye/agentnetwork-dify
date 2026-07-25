# Dify 前后端本地镜像构建与运行

本文用于把当前仓库中的 Dify 前端和后端源码构建为本地 Docker 镜像，并通过现有 Docker Compose 配置运行。镜像模式不会热更新源码；每次修改代码后，需要重新构建对应镜像并重建容器。

## 1. 前置条件

- 已启动 Docker Desktop。
- 当前代码位于 `E:\LuoyangWorks\agentnetwork-dify`。
- Docker Desktop 已有足够的磁盘和内存。
- 如需代理，建议先在 Docker Desktop 的代理设置中配置。当前本机代理端口可填写 `7897`。

先确认当前代码版本：

```powershell
cd E:\LuoyangWorks\agentnetwork-dify
git branch --show-current
git log -1 --oneline
```

## 2. 准备 Docker 环境文件

已有环境文件时不要覆盖，否则可能丢失数据库密码、端口和其他本地配置。

```powershell
cd E:\LuoyangWorks\agentnetwork-dify\dify-main\docker

if (!(Test-Path .env)) {
  Copy-Item .env.example .env
}

if (!(Test-Path envs\core-services\web.env)) {
  Copy-Item envs\core-services\web.env.example envs\core-services\web.env
}
```

编辑 `dify-main\docker\envs\core-services\web.env`，配置真实 AgentNetwork 或宿主机 Mock：

```dotenv
AGENT_NETWORK_PLAN_URL=http://host.docker.internal:8787/service/plan_code
AGENT_NETWORK_EXECUTE_URL=http://host.docker.internal:8787/service/execute_code
AGENT_NETWORK_PLAN_TIMEOUT_MS=60000
AGENT_NETWORK_EXECUTE_TIMEOUT_MS=120000
```

这里必须使用 `host.docker.internal`。如果写成 `127.0.0.1`，Web 容器会访问自身，而不是 Windows 宿主机上的 Mock。

如果接入真实 AgentNetwork，则直接替换成它的地址，例如：

```dotenv
AGENT_NETWORK_PLAN_URL=http://192.168.10.50:9000/service/plan_code
AGENT_NETWORK_EXECUTE_URL=http://192.168.10.50:9000/service/execute_code
```

前端仍然请求 Dify 自己的 `/internal/agent-network/plan` 和 `/internal/agent-network/pseudocode`；由 Dify Web 服务端代理到以上真实地址，无需修改浏览器端代码。

## 3. 构建 API 和 Web 镜像

必须在 `dify-main` 根目录执行，最后的 `.` 表示 Docker 构建上下文，不能改成 `api` 或 `web` 子目录。

```powershell
cd E:\LuoyangWorks\agentnetwork-dify\dify-main
$commitSha = git rev-parse --short HEAD

docker build --progress=plain `
  -f api\Dockerfile `
  -t agentnetwork-dify-api:local `
  --build-arg COMMIT_SHA=$commitSha `
  .

docker build --progress=plain `
  -f web\Dockerfile `
  -t agentnetwork-dify-web:local `
  --build-arg COMMIT_SHA=$commitSha `
  .
```

如果 Docker Desktop 没有使用系统代理，可以临时给构建命令增加：

```powershell
--build-arg HTTP_PROXY=http://host.docker.internal:7897 `
--build-arg HTTPS_PROXY=http://host.docker.internal:7897
```

注意不要把代理账号、密码或其他密钥写入 Dockerfile、Git 文件或镜像标签。

## 4. 启动本地 Mock AgentNetwork

另开一个 PowerShell：

```powershell
cd E:\LuoyangWorks\agentnetwork-dify
$env:HOST = '0.0.0.0'
node .\mock-agent-network-server.mjs
```

应看到：

```text
Mock Agent Network plan endpoint: http://0.0.0.0:8787/service/plan_code
Mock Agent Network execute endpoint: http://0.0.0.0:8787/service/execute_code
```

`0.0.0.0` 仅用于本地 Docker 演示，使容器能够访问宿主机服务。使用公共网络时应留意 Windows 防火墙，不要把 Mock 暴露到不可信网络。

Mock 只模拟规划和执行接口，不会真正运行 AgentNetwork 节点。

## 5. 使用本地镜像启动 Dify

仓库提供了 `docker-compose.local-images.yaml`，它只覆盖官方 API/Web 镜像，不改变已有数据库、Redis、存储卷等配置。

```powershell
cd E:\LuoyangWorks\agentnetwork-dify\dify-main\docker

docker compose `
  -f docker-compose.yaml `
  -f docker-compose.local-images.yaml `
  up -d
```

检查状态：

```powershell
docker compose `
  -f docker-compose.yaml `
  -f docker-compose.local-images.yaml `
  ps
```

默认访问地址通常是 `http://localhost`。如果 `.env` 修改过 `EXPOSE_NGINX_PORT`，则使用对应端口。

## 6. 修改源码后的增量重建

只修改 Web：

```powershell
cd E:\LuoyangWorks\agentnetwork-dify\dify-main
$commitSha = git rev-parse --short HEAD
docker build -f web\Dockerfile -t agentnetwork-dify-web:local --build-arg COMMIT_SHA=$commitSha .

cd docker
docker compose `
  -f docker-compose.yaml `
  -f docker-compose.local-images.yaml `
  up -d --no-deps --force-recreate web
```

修改 API 后，API、异步 Worker 和定时 Worker 使用同一个后端镜像，需要一起重建：

```powershell
cd E:\LuoyangWorks\agentnetwork-dify\dify-main
$commitSha = git rev-parse --short HEAD
docker build -f api\Dockerfile -t agentnetwork-dify-api:local --build-arg COMMIT_SHA=$commitSha .

cd docker
docker compose `
  -f docker-compose.yaml `
  -f docker-compose.local-images.yaml `
  up -d --no-deps --force-recreate api api_websocket worker worker_beat
```

只修改 `web.env` 时不必重新构建镜像，但必须重建 Web 容器：

```powershell
docker compose `
  -f docker-compose.yaml `
  -f docker-compose.local-images.yaml `
  up -d --no-deps --force-recreate web
```

## 7. 日志与故障排查

查看 Web 和 API 日志：

```powershell
docker compose `
  -f docker-compose.yaml `
  -f docker-compose.local-images.yaml `
  logs -f web

docker compose `
  -f docker-compose.yaml `
  -f docker-compose.local-images.yaml `
  logs -f api
```

确认 Compose 最终使用的是本地镜像：

```powershell
docker compose `
  -f docker-compose.yaml `
  -f docker-compose.local-images.yaml `
  config --images
```

结果中应包含：

```text
agentnetwork-dify-api:local
agentnetwork-dify-web:local
```

常见问题：

- 修改源码后页面没变化：镜像不会热更新，需要重新构建并 `--force-recreate`。
- 请求 AgentNetwork 失败：检查 Mock 是否运行、是否监听 `0.0.0.0`，以及 `web.env` 是否使用 `host.docker.internal`。
- 仍在运行旧代码：检查容器最终镜像名，并重建对应容器。
- 构建依赖下载失败：检查 Docker Desktop 代理，而不只是 PowerShell 的代理。
- Web 改动只重建 Web；API 改动要同时重建 API、WebSocket Worker、Worker 和 Worker Beat。

## 8. 停止、保留数据与搬运镜像

停止服务但保留数据：

```powershell
docker compose `
  -f docker-compose.yaml `
  -f docker-compose.local-images.yaml `
  down
```

不要执行 `down -v`，除非明确准备删除 Docker 数据卷。演示环境中的应用、账号和工作流数据需要保留时尤其要注意。

导出镜像到文件：

```powershell
docker save `
  -o E:\LuoyangWorks\agentnetwork-dify\agentnetwork-dify-images.tar `
  agentnetwork-dify-api:local `
  agentnetwork-dify-web:local
```

在另一台机器导入：

```powershell
docker load -i .\agentnetwork-dify-images.tar
```

Compose 配置、`.env`、数据库和存储卷不包含在镜像导出文件中，需要单独迁移和备份。

## 9. 演示前检查清单

1. Docker Desktop 已启动。
2. 当前 Git 提交是需要演示的版本。
3. API 和 Web 镜像已按当前提交重新构建。
4. Compose 最终使用 `agentnetwork-dify-*:local`。
5. Mock 或真实 AgentNetwork 可访问。
6. `/service/plan_code` 和 `/service/execute_code` 地址配置正确。
7. 原有工作流可以打开，新建工作流不会出现 404。
8. 对话生成、画布渲染、保存、查看伪代码和执行完整走通。

