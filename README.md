# Flouho

一个面向全球用户的匿名文件传输网站，当前以英文和中文为主。

核心能力：
- 上传文件后生成 8 位提取码。
- 接收方无需登录，输入提取码即可下载。
- 支持 5MB 分片上传、断点续传、上传/下载进度展示。
- 支持下载次数限制。
- 首页内置公开流量统计模块。
- 提供中英文首页和中英文 SEO 落地页。

## 当前站点结构

- 英文首页：`/`
- 中文首页：`/zh/`
- 英文 SEO 页：
  - `/solutions/large-file-transfer/`
  - `/solutions/anonymous-file-sharing/`
  - `/solutions/send-files-with-code/`
- 中文 SEO 页：
  - `/zh/solutions/large-file-transfer/`
  - `/zh/solutions/anonymous-file-sharing/`
  - `/zh/solutions/send-files-with-code/`

根路径默认是英文站点，中文内容放在 `/zh/` 下。

## 快速开始

```bash
npm install
npm start
```

默认监听端口：

```bash
http://localhost:30022
```

也可以通过环境变量指定端口：

```bash
PORT=30022 npm start
```

## 技术实现

- `server.js` 使用 Node.js 原生 `http` 模块提供 API 和静态资源服务。
- 前端为纯静态页面，核心逻辑在 `public/main.js`。
- 上传文件按 5MB 分片写入 `storage/tmp/`，合并完成后写入 `storage/files/`。
- 上传索引存储在 `storage/index.json`。
- 公共流量统计存储在 `storage/analytics.json`。

## 功能说明

### 文件传输

- 单文件大小限制：`< 2GB`
- 下载次数限制：`1-10` 次
- 默认下载次数：`3` 次
- 支持断点续传
- 支持 HTTP Range 下载

### 存储保护策略

为了适配本机磁盘空间有限的场景，后端已实现保守型存储策略：

- 磁盘保留空间阈值：`12GB`
- 应用存储软上限：`16GB`
- 应用存储硬上限：`20GB`
- 上传准入按峰值占用评估：
  - 估算公式约为 `当前存储 + 文件大小 x 2 + 512MB`
  - 如果超过硬上限，或上传后系统剩余空间会低于 `12GB`，则拒绝上传

### 自动删除策略

- 未完成上传：`30 分钟` 无新分片写入则清理
- 已上传完成但从未下载：`4 小时` 后自动删除
- 已下载过的文件：
  - 最后一次下载后 `12 小时` 删除
  - 或首次下载后 `24 小时` 删除
  - 取更早的那个时间点
- 绝对最长生命周期：`72 小时`
- 当应用存储超过软上限时，会优先回收已下载过的旧文件

## SEO 与国际化

当前工程已经包含：

- 英文默认首页和中文首页
- 语言切换链接
- `canonical`、`hreflang`、Open Graph、Twitter Meta
- `robots.txt`
- `sitemap.xml`
- 中英文 SEO 落地页
- 首页 FAQ 与结构化数据

说明：
- `/` 默认服务英文页面
- `/zh/` 服务中文页面
- `/en`、`/en/` 会重定向到 `/`

## 流量统计

首页底部展示公开统计信息，数据来源于 `storage/analytics.json`。

当前统计包括：
- 总访问量
- 今日访客数
- 累计上传数
- 累计下载数
- 当前有效文件数
- 最近 7 天访问趋势

公开统计接口：

```bash
GET /api/stats/public
```

## 目录结构

```text
.
├── server.js
├── package.json
├── public/
│   ├── index.html
│   ├── zh/
│   ├── solutions/
│   ├── main.js
│   ├── styles.css
│   ├── robots.txt
│   └── sitemap.xml
└── storage/
    ├── analytics.json
    ├── index.json
    ├── files/
    └── tmp/
```

## 运行与部署说明

- 本地开发可直接运行 `npm start`
- 生产环境通常由 Nginx 或其他反向代理把 `80/443` 转发到 `30022`
- 若使用 `systemd`，确保服务启动命令指向：

```bash
/usr/bin/node /root/workspace/anet/server.js
```

## 安全性与稳定性

- 基础安全响应头：
  - `X-Content-Type-Options`
  - `X-Frame-Options`
  - `Referrer-Policy`
  - `Cross-Origin-Resource-Policy`
- JSON 请求体和分片请求体都有大小限制
- 上传参数、提取码、Range 请求都有校验
- 服务端设置了请求超时和 `clientError` 处理
- 下载接口默认带 `X-Robots-Tag: noindex, nofollow, noarchive`

## 备注

- `public/index.html.bak` 是历史备份文件，不参与正式站点路由。
- `storage/` 下的数据是运行时数据，不建议直接手工修改线上内容。
