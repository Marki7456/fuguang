# 我的 iOS Location Spoofer 独立副本

此项目来自用户在 Safari 中打开的 [CyberHandyman 页面](https://cyberhandyman-ioslocspo.cyberhandyman.workers.dev/)，保留 2026-10-28 取得的首页、地图选点页、客户端模块、设备本地存储脚本与图标，并将资源链接改为当前部署站点。

原始贡献来源包括 [mekos2772/ios-location-spoofer](https://github.com/mekos2772/ios-location-spoofer)、[acheong08/ios-location-spoofer](https://github.com/acheong08/ios-location-spoofer) 及原站标注的 Yu9191/wloc（制作副本时公开链接返回 404）。AGPL-3.0 许可证见 LICENSE。原站署名、水印与声明保留；本副本与原站维护者、Apple 均无隶属关系。

## 内容

- `public/`：可直接修改的网页、图标、模块与设备脚本。
- `worker/handler.js`：本站路由和地图链接解析逻辑。替代原站未公开的 `/api/parse` 后端，支持直接坐标及部分 Apple、Google、高德、百度地图链接；分享页格式变化可能导致解析失败，可改用经纬度。
- `scripts/build-worker.py`：将资源内嵌到独立 Worker，并提供完整对应源码下载 `/source.zip`。
- `tests/fork.test.mjs`、`tests/picker-harness.mjs`：检查站内路由、模块依赖、页面语法、坐标解析，并执行真实页面脚本与模拟设备存储的状态回归测试。
- `.openai/hosting.json`：Sites 部署身份；迁移时使用自己的项目身份。

## 本地预览

安装 Node.js 22+ 和 Python 3 后，在项目目录运行：

```sh
bash scripts/build.sh
node tests/fork.test.mjs
node scripts/preview.mjs
```

打开 `http://127.0.0.1:8787`。修改资源后重新构建并重新启动预览。

## 自动构建与检查

`.github/workflows/ci.yml` 在每次推送、Pull Request 和手动触发时，使用 Node.js 22 与 Python 3.12（Python 3）执行：

```sh
npm run build
npm test
npm run validate
npm run check:generated
cmp worker/index.js dist/server/index.js
cmp .openai/hosting.json dist/.openai/hosting.json
```

项目只使用 Node.js 和 Python 标准库，没有需要安装的依赖或锁文件，因此 CI 不执行 `npm install` / `npm ci`。流程只有仓库读取权限，不发布网站、不执行 Cloudflare 部署，也不需要部署密钥。

`worker/index.js` 是需要提交的生成文件。构建会内嵌 `public/`、`worker/handler.js` 和对应源码归档；README、测试、构建脚本和 CI 配置等源码文件的变化，也会使归档内容变化。修改后请运行 `npm run build`，将源码和更新后的 `worker/index.js` 一起提交；`dist/` 继续由构建生成，不提交。

`npm run check:generated` 应在构建后运行：若重新生成的 `worker/index.js` 与 Git 索引中的版本不同，会显示文件变更统计并以非零状态退出。在 CI 的干净检出中，这就是与本次提交版本比较。两个 `cmp` 检查部署目录中的 Worker 和托管配置是否完整复制。

上述检查覆盖网页路由、模块链接、页面脚本语法、坐标解析、模拟客户端 API 的设备配置保存/查询/清除，以及部署产物能否作为 ESM 加载并导出 `default.fetch`。它们不能验证真实 iPhone 上的定位是否生效、iOS 版本兼容性、代理客户端的模块导入和请求拦截、设备持久化行为，也不验证第三方地图服务的实时可用性。这些仍需使用目标 iPhone、iOS 版本和代理客户端实测。

## 设备定位状态

页面根据设备返回的 `enabled` 和合法经纬度展示状态；经度或纬度为 `0` 都是有效位置。

| 设备查询结果 | 页面展示 | 收藏标记 |
| --- | --- | --- |
| 有合法坐标，`enabled: true` | 已启用定位及坐标 | 匹配的位置标记“已启用” |
| 有合法坐标，`enabled: false` | 已保存但停用及坐标 | 无启用标记 |
| 无保存坐标，`hasCoordinates: false` | 无已保存的坐标 | 无启用标记 |
| 网络、HTTP、JSON、存储错误，或状态/坐标无效 | 查询失败，无法确认定位状态 | 无启用标记 |

“停用定位”和“恢复真实定位”均写入 `enabled=false`，保留已保存的经纬度；再次选择同一位置（也可从收藏载入）并储存即可重新启用。停用后重新打开页面不会把旧坐标自动选为已启用目标。查询中同样隐藏启用标记；较早发出的查询不会覆盖后续保存或停用的结果，写入期间不再发送并发的页面操作。保存显示设备确认的坐标，避免等待响应时移动地图造成显示错位。

设备脚本在保存、停用和查询时返回一致的状态结构，写入失败会返回错误。页面仍兼容旧版脚本的 `No saved coordinates` 空存储响应及缺少状态字段的保存/停用响应（后者会再查询一次）。六种客户端继续使用原有模块和存储接口：Surge、Shadowrocket、Egern、Loon、Stash 使用 `$persistentStore`，Quantumult X 使用 `$prefs`，响应封装不变。

回归测试执行构建后的实际页面与设备脚本，以 DOM、Leaflet 和客户端存储替身覆盖保存、再次查询、刷新/重新打开、两个停用入口、重新启用、纬度 0、经度 0、`(0,0)`、错误响应、失败写入、旧版响应及延迟查询。六种客户端名称对应两类模拟 API，**不是六款真实客户端的兼容性实测**。

真实 iPhone Safari 验证仍待执行，建议逐一记录客户端及版本、iOS 版本和以下结果：

1. 保存普通位置，确认“已启用定位”，再查询和重新打开页面，核对坐标及收藏标记。
2. 分别使用“停用定位”和“恢复真实定位”，确认“已保存但停用”；刷新、关页重开及再次查询均不得出现启用标记。
3. 从收藏载入原坐标并再次储存，确认重新启用；依次以纬度 0、经度 0 和 `(0,0)` 重复保存、停用、重开、重新启用。
4. 在无保存坐标时确认空状态；请求拦截不可用或网络失败时确认“查询失败”，而非空状态或已启用状态。
5. 单独检查系统及目标 App 的真实定位是否按预期恢复/改变。页面的“已启用”仅确认设备配置开关，不能证明 iOS 已采用该位置。

## Cloudflare Workers 迁移

运行 `bash scripts/build.sh` 生成 `dist/server/index.js`，部署该文件即可，无需数据库、KV 或坐标记录服务。`wrangler.jsonc` 提供独立部署配置。使用自己的 Cloudflare 账号登录后执行 `npx wrangler deploy`。

## 使用和验证范围

首页提供 Surge、Shadowrocket、Egern、Loon、Stash、Quantumult X 的模块链接。设备保存功能由代理客户端拦截 `https://gs-loc.apple.com/ils-settings/save` 请求实现，配置坐标保存在设备端。电脑未安装相应代理模块时，选点页会正确显示设备配置不可读提示；这不等于服务器保存失败。

地图瓦片、地址搜索和海拔查询仍调用页面所用的第三方服务；搜索词、视野范围、查询坐标会按相应功能发往服务提供方。因此「设备本地保存」并不表示所有地图操作离线或不经过外部服务。

模块与脚本地址必须能被代理客户端免登录读取。私有 Sites 预览可查看界面，但私有站点的登录保护可能阻止代理下载脚本；正式导入前应发布为公开站点，或将资源部署到自己可免登录访问的托管服务。

未在真实 iPhone 上验证定位生效、系统兼容性或各代理客户端的导入结果。上游当前 README 提示 iOS 27 正式版不可用；请勿将网页复制或脚本检查通过视为真机定位成功。
