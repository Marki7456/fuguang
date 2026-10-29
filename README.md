# 我的 iOS Location Spoofer 独立副本

此项目来自用户在 Safari 中打开的 [CyberHandyman 页面](https://cyberhandyman-ioslocspo.cyberhandyman.workers.dev/)，保留 2026-10-28 取得的首页、地图选点页、客户端模块、设备本地存储脚本与图标，并将资源链接改为当前部署站点。

原始贡献来源包括 [mekos2772/ios-location-spoofer](https://github.com/mekos2772/ios-location-spoofer)、[acheong08/ios-location-spoofer](https://github.com/acheong08/ios-location-spoofer) 及原站标注的 Yu9191/wloc（制作副本时公开链接返回 404）。AGPL-3.0 许可证见 LICENSE。原站署名、水印与声明保留；本副本与原站维护者、Apple 均无隶属关系。

## 内容

- `public/`：可直接修改的网页、图标、模块与设备脚本。
- `worker/handler.js`：本站路由和地图链接解析逻辑。替代原站未公开的 `/api/parse` 后端，支持直接坐标及部分 Apple、Google、高德、百度地图链接；分享页格式变化可能导致解析失败，可改用经纬度。
- `scripts/build-worker.py`：将资源内嵌到独立 Worker，并提供完整对应源码下载 `/source.zip`。
- `tests/fork.test.mjs`：检查站内路由、模块依赖、页面语法、坐标解析及两种客户端存储 API 的保存、查询、清除。
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

## Cloudflare Workers 迁移

运行 `bash scripts/build.sh` 生成 `dist/server/index.js`，部署该文件即可，无需数据库、KV 或坐标记录服务。`wrangler.jsonc` 提供独立部署配置。使用自己的 Cloudflare 账号登录后执行 `npx wrangler deploy`。

## 使用和验证范围

首页提供 Surge、Shadowrocket、Egern、Loon、Stash、Quantumult X 的模块链接。设备保存功能由代理客户端拦截 `https://gs-loc.apple.com/ils-settings/save` 请求实现，配置坐标保存在设备端。电脑未安装相应代理模块时，选点页会正确显示设备配置不可读提示；这不等于服务器保存失败。

地图瓦片、地址搜索和海拔查询仍调用页面所用的第三方服务；搜索词、视野范围、查询坐标会按相应功能发往服务提供方。因此「设备本地保存」并不表示所有地图操作离线或不经过外部服务。

模块与脚本地址必须能被代理客户端免登录读取。私有 Sites 预览可查看界面，但私有站点的登录保护可能阻止代理下载脚本；正式导入前应发布为公开站点，或将资源部署到自己可免登录访问的托管服务。

未在真实 iPhone 上验证定位生效、系统兼容性或各代理客户端的导入结果。上游当前 README 提示 iOS 27 正式版不可用；请勿将网页复制或脚本检查通过视为真机定位成功。
