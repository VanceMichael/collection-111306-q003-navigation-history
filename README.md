# 浏览器历史恢复中的目录观察身份

操作员在资料门户里来回切换设备，采集助手一直跟着记录。这里保存现有资料预览工具、连续导航采集器和本地供方模拟服务，便于离线开发和复查领取行为。

## 当前能力

- **原样保留的浏览器查看方式**：`npm run preview` 仍是单次观察入口，用真实浏览器打开本地门户，读取一次可见内容并写入 `var/captures.json`。
- **跟随导航的连续采集**：`npm run demo` 在同一浏览器会话里依次演示同文档路由、筛选变化、同地址新历史项、锚点、跨文档往返、浏览器缓存恢复与重新确认，把每一步写入同一条接收序列。
- **恢复记录**：跨文档后退若由浏览器前进后退缓存恢复，结果为“浏览器恢复的展示”，可预览但不能当成最新资料；只有重新确认取得新响应后才升级。

`src/domain.mjs` 提供领域分类、历史项身份与接收账本；`src/collect.mjs` 提供导航状态机与浏览器入口；`src/store.mjs` 仍是带完整性校验的单进程顺序接收文件，不是跨进程事务数据库。

## 每条结果记录什么

每条接收记录都带：

- `navigation.epoch`：属于哪次导航（新文档、同文档、恢复）。
- `historyItem`：哪个历史项，以 Navigation API 的 `entry.key` 为准；`index`、`item` 与 `filter` 保留该历史项的筛选状态。同一地址的两个历史项 key 不同。
- `document`：哪份文档（页面内随机身份，跨文档往返恢复同一文档时保持不变）。
- `basis`：实际取数依据。`network` 表示页面确为本次观察发起了 `/api/snapshot` 请求，其中的 `probe` 是采集器亲眼看到的请求代号，`observedStatus`、`observedGeneration` 与 `verified` 来自采集器捕获的真实响应，而不是页面自述。
- 判定字段：`classification`、`fresh`、`confirmed`、`preview`、`applied`、`late`、`stale`。

业务含义只有三类，另有若干“还不知道”的中间态：

| classification | 含义 |
| --- | --- |
| `fresh-response` | 真正的新响应，且采集器核对过响应状态与数据代次 |
| `same-document-change` | 同文档内的路由、筛选、锚点或历史移动，沿用已取到的资料 |
| `restored-display` | 浏览器恢复的旧展示，只有预览资格 |
| `document-navigation` | 换了文档，尚无取数依据 |
| `pending` / `unverified-response` / `failed-response` | 取数未完成、缺可核对证据或取数失败 |

`pageshow` 本身不是领取依据：只有 `persisted === true` 的恢复才算恢复展示，普通 `pageshow` 被忽略并记录在 `ignored` 中。

## 状态不倒退、不串设备

- 采集器以 CDP 的主框架导航与同文档导航事实推进状态；页面上报必须对得上最近一次导航事实。
- 事件序号倒退、页面现场已切到其它文档或其它历史项、以及被后续导航取代的上报都留档为 `stale`/`late`，`applied` 与 `confirmed` 均为 false，不更新当前历史项。
- 账本的 `latestConfirmed` 只由当前、未迟到、可核对的新响应推进；恢复展示与同文档变化只更新 `current` 与 `previews`。
- 恢复过的历史项重新确认后会标记 `upgradedFromPreview`，并从 `previews` 转入 `confirmedEntries`。

## 运行

容器内固定 Playwright 1.56.1 与匹配的 Chromium。浏览器只访问本进程启动的回环资料源，不需要访问外部门户。

```sh
npm ci
npx playwright install chromium
npm run build
npm test
npm run demo
```

推荐使用固定镜像构建，首次构建会安装锁文件中的依赖；运行时不需联网。

```sh
docker build -t plant-navigation-history .
docker run --rm --network none --ipc=host plant-navigation-history npm test
docker run --rm --network none --ipc=host plant-navigation-history npm run demo
```

开发时 `npm start` 打印本地源地址；设置 `PORT` 可指定监听端口，未设置时自动分配回环端口。浏览器页面或 HTTP 接口可直接查看。`CAPTURE_PATH` 可改变接收文件路径。重复运行追加记录；删除 `var` 可从空接收状态开始。

### 浏览器前进后退缓存

Playwright 默认传入 `--disable-back-forward-cache`，普通无头模式也不会主动启用缓存。连续采集默认移除该默认参数，使用 Chromium 新无头通道，让跨文档后退真实触发 `pageshow.persisted`；若无法启用则退回普通启动，此时返回会产生新的文档响应，采集结果如实记为 `fresh-response` 而不是恢复展示。两种情况下跨文档往返都可观察，但不会互相冒充。

## 模块

- `src/source.mjs`：本地资料源与演示控制。
- `src/domain.mjs`：结果分类、历史项身份、观察记录与接收账本。
- `src/collect.mjs`：连续导航采集状态机与浏览器入口。
- `src/preview.mjs`：原有单次预览入口，保留不动。
- `src/demo.mjs`：短时连续采集演示。
- `src/store.mjs`：带完整性校验的顺序接收文件。
- `fixtures/source.json` 与 `fixtures/controls.json`：本地供方资料及可切换情形。
- `docs/source.md`：接口和来源约定。
- `test`：预览、源端特殊情形、接收文件完整性、导航状态机与真实浏览器导航测试。

## 业务核对

以下情况可被独立观察，而不只是源端能够制造：

- 同文档路由无新文档。
- 同地址不同历史状态。
- 后退恢复不能宣称新响应。
- 快速前后导航隔离迟到事件。
- 结果可回查文档和历史项依据。

新增行为在独立模块扩展，保留原有预览调用；源端模拟器不为接收器完成核对。

## 短时操作演示

从空 `var` 运行 `npm run demo`，展示本次真实读取、连续接收与恢复判断；再运行 `npm test` 查看本地源边界与接收文件检查。固定环境中的这两步应在 90 秒内完成。演示入口输出实际完成情况、未确认部分及原因，不回放旧日志，不以源端控制操作代替接收结果。
