# 我的 iOS Location Spoofer 独立副本

此项目来自用户在 Safari 中打开的 [CyberHandyman 页面](https://cyberhandyman-ioslocspo.cyberhandyman.workers.dev/)，保留 2026-10-28 取得的首页、地图选点页、客户端模块、设备本地存储脚本与图标，并将资源链接改为当前部署站点。

原始贡献来源包括 [mekos2772/ios-location-spoofer](https://github.com/mekos2772/ios-location-spoofer)、[acheong08/ios-location-spoofer](https://github.com/acheong08/ios-location-spoofer) 及原站标注的 Yu9191/wloc（制作副本时公开链接返回 404）。AGPL-3.0 许可证见 LICENSE。原站署名、水印与声明保留；本副本与原站维护者、Apple 均无隶属关系。

## 内容

- `public/`：可直接修改的网页、图标、模块与设备脚本。
- `worker/handler.js`：本站路由和地图链接解析逻辑。替代原站未公开的 `/api/parse` 后端，支持直接坐标及部分 Apple、Google、高德、百度地图链接；分享页格式变化可能导致解析失败，可改用经纬度。
- `scripts/build-worker.py`：将资源内嵌到独立 Worker，并提供完整对应源码下载 `/source.zip`。
- `tests/fork.test.mjs`、`tests/picker-harness.mjs`：检查路由、模块、页面语法、坐标解析，并执行真实页面和设备脚本的模拟状态回归。
- `.openai/hosting.json`：Sites 部署身份；迁移时使用自己的项目身份。

## 本地预览

安装 Node.js 22+ 和 Python 3 后，在项目目录运行：

```sh
bash scripts/build.sh
node tests/fork.test.mjs
node tests/protocol.test.mjs
node tests/settings.test.mjs
node tests/picker.test.mjs
node scripts/validate-artifact.mjs
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

页面区分设备保存、停用、空配置和读取失败。纬度 0、经度 0 与 (0,0) 都是有效坐标。

| 设备查询结果 | 页面状态 |
| --- | --- |
| 修复版设置脚本、合法坐标且 enabled=true | 设备已保存的坐标；匹配收藏标记“设备已保存” |
| enabled=false 且有合法坐标 | 已保存但停用；保留坐标，没有启用标记 |
| hasCoordinates=false 且 enabled=false | 无已保存的坐标 |
| 网络、HTTP、JSON、存储错误或无效状态 | 查询失败，无法确认定位状态 |
| 设置脚本版本过旧或缺少版本，且未确认停用 | 提示更新；阻止保存，保留停用入口 |

停用不会删除设备保存的坐标或浏览器收藏，也不会自动选中旧坐标。页面设备操作串行执行；每次请求连同 JSON 读取最多等待 8 秒，超时后释放按钮。保存时移动地图不会改变这次请求的目标或成功提示。

已有的六客户端状态回归使用两类模拟存储 API，覆盖保存、重开、停用、重新启用、零坐标、错误响应、缓存旧脚本及延迟请求。这不是六款客户端或真实 iPhone 的兼容性实测。系统实际定位仍需在目标 iPhone 的地图 App 中确认。

## Cloudflare Workers 迁移

运行 `bash scripts/build.sh` 生成 `dist/server/index.js`，部署该文件即可，无需数据库、KV 或坐标记录服务。`wrangler.jsonc` 提供独立部署配置。使用自己的 Cloudflare 账号登录后执行 `npx wrangler deploy`。

## 使用和验证范围

首页提供 Surge、Shadowrocket、Egern、Loon、Stash、Quantumult X 的模块链接。设备保存功能由代理客户端拦截 `https://gs-loc.apple.com/ils-settings/save` 请求实现，配置坐标保存在设备端。电脑未安装相应代理模块时，选点页会正确显示设备配置不可读提示；这不等于服务器保存失败。

地图瓦片、地址搜索和海拔查询仍调用页面所用的第三方服务；搜索词、视野范围、查询坐标会按相应功能发往服务提供方。因此「设备本地保存」并不表示所有地图操作离线或不经过外部服务。

模块与脚本地址必须能被代理客户端免登录读取。私有 Sites 预览可查看界面，但私有站点的登录保护可能阻止代理下载脚本；正式导入前应发布为公开站点，或将资源部署到自己可免登录访问的托管服务。

未在真实 iPhone 上验证定位生效、系统兼容性或各代理客户端的导入结果。网页保存成功只表示设置脚本将配置写入设备，不能证明系统定位已改变；请勿将脚本测试通过视为真机定位成功。

## 2026-11-01 兼容修复（1.1.0 / 20261101.1）

修复依据是 iOS 18.7 + Shadowrocket 用户报告：保存后所有地图持续定位，关闭模块后恢复。离线协议测试确认旧脚本会删除部分根字段、重建定位元数据，并改变部分响应封装。通用定位脚本现改为只替换已存在且有效的经纬度与已有水平精度，保留海拔、垂直精度、运动状态、其它字段和原有封装；无坐标、不需改写、坏格式或异常响应原样放行。不再为缺少定位的记录补造位置。

设置脚本会严格检查输入和存储结果，先关闭再写入，成功后才启用。返回的 `settingsVersion` 供选点页检查设置脚本是否更新；该检查不能证明定位核心脚本已刷新或手机定位已生效。页面的设备请求有等待上限，并明确显示停用状态及合法的零坐标；保存完成提示对应发起请求时所选的位置。

通用脚本的 Shadowrocket / Surge / Egern、Loon、Stash 模块地址使用 `?v=20261101.1` 刷新脚本缓存，模块名称不变。没有新增拦截域名或请求改写规则。Quantumult X 仍使用独立 `location-spoofer-qx.js`，不包含本次定位核心修复；所有客户端均未做真实 iPhone 验证。

手机更新步骤：

1. 先停用旧模块，确认正常定位恢复。
2. 在小火箭「配置 → 模块」更新现有 `iOS Location Spoofer (Stateless)`；若重新导入，替换同名模块，只保留一份。刷新网页本身不会更新手机脚本。
3. 更新后重新连接小火箭，再打开本站选点页保存，并到地图 App 检查结果。
4. 如果仍持续转圈，停用模块恢复真实定位，不要持续等待或反复叠加模块。

`tests/protocol.test.mjs` 使用合成二进制响应和 VM 模拟客户端入口，检查字段/封装保留、失败放行和单次结束；`tests/settings.test.mjs` 检查参数、存储失败及禁用状态；`tests/picker.test.mjs` 检查页面设备请求和状态提示。它们不能替代 iOS 18.7 真机复测。
