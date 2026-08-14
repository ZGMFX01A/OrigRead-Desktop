# OrigRead Desktop 开发计划

## 1. 总原则

Android 是业务行为基线，Electron Desktop 是独立实现。

不要求 Kotlin 与 TypeScript 共享源码，但业务语义必须对齐。开发 Desktop 时默认只修改本仓库；如果发现 Android 存在真实问题，应单独记录并在 Android 仓库修复，禁止为了适配 Desktop 直接改 Android 正确逻辑。

### 来源添加的 Android 基线

以 Android `SubscribeViewModel.searchFeed()` 为准：

1. 显式 JSON/API 地址优先且只走 JSON 探测；
2. 普通 URL：RSS/Atom；
3. RSSHub；
4. JSON/API；
5. 静态 WebsiteRule / 自动 DOM；
6. 前述候选均未通过健康检查时，才启动动态 WebView/Chromium；
7. 所有候选统一评分后选择最佳项；
8. RSSHub、Website、JSON 保存语义与 Android 一致。

Electron 侧可以使用不同库，但不得擅自调整以上优先级、回退条件、超时语义和候选选择规则。

## 2. 技术栈

- Electron 43
- TypeScript
- React 19
- electron-vite 5 + Vite 7
- electron-builder
- i18next / react-i18next
- Vitest
- SQLite（Phase 2 引入）

Windows 使用 NSIS，macOS 使用 DMG。动态网页与原文阅读直接使用 Electron 自带 Chromium，不再额外引入 JCEF/KCEF。

## 3. 安全边界

- Renderer：`nodeIntegration=false`
- Renderer：`contextIsolation=true`
- Renderer：`sandbox=true`
- Renderer 不直接操作 Node、文件、数据库、系统 Shell
- preload 只暴露明确、窄范围、可类型检查的 API
- 主进程校验 IPC 输入与 URL
- 远程网页使用独立 WebContents，并禁止 Node 集成
- 默认禁止任意新窗口和页面导航

## 4. 迁移映射

| 能力 | Android 基线 | Electron 目标 |
|---|---|---|
| 添加来源编排 | `SubscribeViewModel` | `main/source-discovery` |
| RSS/Atom | `RssHelper` | `main/sources/rss` |
| RSSHub | `RssHubResolver` | `main/sources/rsshub` |
| JSON/API | `JsonSourceHelper` | `main/sources/json` |
| WebsiteRule / 自动 DOM | `WebsiteHelper` | `main/sources/website` |
| 动态网页 | Android WebView | Chromium `WebContentsView` / hidden webContents |
| 同步分派 | `LocalSourceService` | `main/sync` |
| 文章 / 来源 / 分组 | Room Model/DAO | SQLite Repository |
| 阅读状态 / 星标 | Android Article DAO | SQLite Article Repository |
| 全文提取 | `RssHelper.parseFullContent` 等 | `main/content` |
| 翻译 | `TranslationService` | `main/translation` |
| AI 摘要 | 阅读 ViewModel + AI Service | `main/ai` |
| OPML | `OpmlService` | `main/import-export/opml` |
| 完整配置备份 | `ConfigurationBackupService` | `main/backup`，保持 schema 兼容 |

## 5. 阶段计划

### Phase 1：Electron 工程骨架

- [x] 独立 Electron Git 仓库
- [x] Electron + TypeScript + React
- [x] electron-vite
- [x] main / preload / renderer 分层
- [x] 安全 BrowserWindow 默认配置
- [x] 基础 i18n：中文显示“原读”，英文显示“OrigRead”
- [x] OrigRead Logo
- [x] 双区桌面 UI 骨架
- [x] 左侧工作区垂直居中的折叠/展开手柄
- [x] Windows 实际启动验证
- [x] Windows NSIS 实际打包验证
- [x] sandbox 模式下 preload 固定构建为 CommonJS，避免 ESM preload 导致 renderer bridge 丢失和白屏
- [x] Playwright Electron Renderer Smoke：实际验证 `.app-shell`、品牌、导航、阅读区和 `window.origread`
- [x] Renderer Smoke 覆盖品牌 Logo 资源实际加载，避免 file:// 生产模式使用绝对路径导致裂图
- [x] Renderer Smoke 覆盖工作区收起/展开；收起后阅读区必须接近全窗口宽度
- [x] Renderer 启动兜底：preload bridge 异常时显示明确错误页，不允许静默白屏
- [ ] macOS CI 启动验证

### Phase 2：本地数据层

- [x] SQLite 选型与接入：使用 Electron 43 内置 Node `node:sqlite`，不增加 native addon
- [x] Group / Feed / Article / Read / Starred schema
- [x] RSSHub 原始 source URL 映射表
- [x] Repository 与事务基础
- [x] 数据库 schema migration 基础
- [x] schema v2 实际迁移：为 Article 增加 `imageUrl`，开发机旧 v1 数据库可自动升级
- [x] 重启后持久化回归测试
- [x] 只读 Library Snapshot IPC
- [x] 设置 Repository 与设置 IPC
- [x] Renderer 真实文章/来源查询 IPC
- [x] 已读 / 星标写入 IPC
- [x] 工作区折叠状态持久化

### Phase 3：来源发现

- [x] RSS/Atom 直接 Feed 解析
- [x] 普通网页 `rel=alternate` RSS/Atom 发现
- [x] Android 同序的 `/feed`、`/rss`、`rss.xml`、`atom.xml`、`feed.xml`、`index.xml` 回退
- [x] 每个候选实际请求并解析，不根据 URL 后缀猜测
- [x] RSS 添加后 Feed / Article 原子落库
- [x] RSS 手动刷新
- [x] 按 Android `feedId + link` 语义稳定去重，刷新不覆盖本地已读 / 星标
- [x] RSS 添加/刷新 IPC 与 UI 闭环
- [x] fixture 行为对照测试
- [x] 真实公网验证：`https://github.blog/feed/` 成功发现 `https://github.blog/feed` 并解析文章
- [ ] RSS 图标发现完全对齐 Android `BestIconFinder`（当前优先使用 Feed 自带 image）
- [x] RSSHub 路由目录：复制 Android 当前 `rsshub_routes.json` 数据资产，schema / routeCount 校验一致
- [x] RSSHub TypeScript matcher：host/path/query/动态参数/缺参/可选参数/安全约束与 Android 对照
- [x] RSSHub 16 个默认实例、最近成功优先、网络失败 5 分钟冷却、自定义实例持久化
- [x] RSSHub Resolver：单实例有限候选并发、实例间顺序 fallback、5s 单请求 / 9s 总预算
- [x] RSSHub settings / instance health IPC 已接入 main / preload
- [x] RSSHub 订阅持久化语义：最终 Feed URL + 原始页面 URL mapping 原子保存
- [x] RSSHub 固定地址失效恢复：重新匹配实例/路由，只更新 Feed URL，不删除历史文章
- [x] Android RSSHub fixture 行为对照测试
- [x] 真实公网验证：`https://www.cls.cn/` 自动跳过不可用实例，在 `rsshub.rssforever.com` 获得电报 20 篇、热门榜 13 篇
- [x] RSSHub 候选接入 Android 同序“统一来源评分/添加”入口，不使用 Desktop 专属简单 fallback
- [x] JSON/API 规则模型与 Android schemaVersion=1 兼容
- [x] 受限 JSONPath：`$.a.b`、数组下标、`[*]`，并复用同一校验器验证导入规则
- [x] JSON5 宽松解析，对齐 Android `Json { isLenient = true }`
- [x] 时间戳 / Android `dateFormat` 日期解析、HTML 标题/作者纯文本化、相对 URL 解析、link 去重与 maxItems
- [x] WordPress：直接 posts endpoint、子目录安装优先、根目录 fallback、无效响应不误判
- [x] Next `__NEXT_DATA__` / Nuxt `__NUXT_DATA__` 静态内嵌 JSON，不执行 JavaScript
- [x] 用户 JSON 规则 Repository：导入、导出、模板、启停、删除、host 匹配；文件独立保存在 Desktop userData
- [x] JSON Rule main/preload IPC 已接入，设置 UI 后续再做
- [x] Probe / Fetch 共用同一个 rule + parser，避免“添加能识别、同步换算法”
- [x] JSON 订阅语义：保存实际 endpoint，随后立即执行一次同步填文章；刷新不覆盖本地已读/星标
- [x] Android JSON fixture 行为对照测试
- [x] 真实公网验证：`https://wordpress.org/news/` 命中子目录 WordPress REST endpoint 并解析 30 篇文章
- [x] Windows 生产包验证 JSON rule bridge / schemaVersion=1 template 可用
- [x] JSON 候选接入 Android 同序统一来源评分/添加入口
- [x] WebsiteRule：schemaVersion=1、IT之家内置规则、用户规则 Repository / import / export / template / enable / delete
- [x] 静态 HTML：Cheerio + ConfigurableWebsiteParser，链接/图片/日期/URL_ID_RANGE 清理语义与 Android 对齐
- [x] 自动 DOM v7：重复 DOM、URL pattern 聚类、导航污染过滤、稳定 selector、区域评分、链接质量评分
- [x] 自动日期链：metadata → JSON-LD → attributes → nearby text → URL date → fetchedAt
- [x] 自动规则缓存 / 稳定性：来源级缓存、连续选择历史、5 次缓存复用后周期 full scan、失效后当次重扫
- [x] Android `website-samples` 20 份 HTML fixture 原样复制到 Desktop 并通过行为覆盖
- [x] Chromium 动态网页兜底：隐藏 BrowserWindow，15s 总超时、1.2s DOM settle、同站跳转、8 次主导航上限、750k DOM 上限、微信验证码识别
- [x] 动态 Chromium 只负责渲染 DOM，渲染后仍复用同一 WebsiteRule / 自动 DOM / 健康评分，不另写动态 parser
- [x] 真实 Electron E2E：页面初始无文章，JavaScript 延迟生成 5 条后由隐藏 Chromium 捕获并成功进入自动 DOM
- [x] 统一健康评分：RSS direct +20、页面发现 RSS +17、JSON +14、RSSHub +10、Website +6、Dynamic +4；内容无效候选不能靠类型 bonus 通过
- [x] Android 同序统一发现：显式 JSON 短路；否则 RSS → RSSHub → JSON → 静态 Website；仅所有静态候选均未通过评分时启动动态 Chromium
- [x] 添加来源 UI 两阶段闭环：检测 → 展示排序后的候选/评分/文章数 → 用户可手选 → 使用同一次主进程探测结果保存
- [x] 本地 Electron E2E：从添加来源 UI 输入 RSS → 统一检测 → 候选选择 → SQLite 订阅落库
- [x] `https://www.cls.cn/` 统一总入口真实公网验证：最终选中 RSSHub 热门榜，评分 90 / 13 篇，动态 Chromium 调用次数 0
- [x] RSS/Atom Android 行为对照测试
- [x] RSSHub Android 行为对照测试
- [x] JSON Android 行为对照测试
- [x] Website 行为对照测试

### Phase 4：同步与文章列表

- [x] 来源周期同步
- [x] SQLite 时间线按发布时间排序
- [x] 未读 / 已读
- [x] 星标
- [x] 来源列表
- [x] 文章 / 来源本地搜索
- [x] RSS / JSON / Website 手动刷新与错误展示
- [x] `SourceSyncService` 统一按 sourceType 分派 RSS / JSON / Website；RSSHub 继续由 RSS service 内部做地址失效恢复
- [x] 对齐 Android `Semaphore(16)`：全来源同步最多 16 个并发，整轮共享同一个 fetchedAt
- [x] 单来源失败不取消其他来源；全量结果逐项汇总，失败时返回 `retryRecommended=true`
- [x] main / preload 提供统一 `refreshSource` / `refreshAllSources` IPC，Renderer 单来源刷新和“刷新全部”均走统一入口
- [x] Electron E2E：添加本地 RSS 后从 UI 分别执行单来源刷新和刷新全部，均触发真实网络请求
- [x] `PeriodicSyncScheduler`：递归 `setTimeout`，上一轮完成后才安排下一轮，避免慢网络下重叠执行
- [x] 同步间隔对齐 Android：手动 / 15 / 30 / 60 / 120 / 180 / 360 / 720 / 1440 分钟，默认 30 分钟
- [x] “启动时同步一次”对齐 Android，默认关闭；设置变更后即时重排周期 timer
- [x] 手动“刷新全部”与周期同步共用同一 scheduler，重叠触发复用同一个 active run
- [x] Renderer 订阅同步运行状态：展示上次 / 下次同步；周期任务完成后自动重载文章列表
- [x] Electron E2E 使用隔离 `userData`，同步/设置测试不再污染开发机订阅数据库

### Phase 5：阅读

- [x] 已存正文读取：`fullContentHtml` → `contentHtml` → 纯文本 description fallback
- [x] 对齐 Android `ContentHtmlSanitizer`：移除 script/iframe/交互节点与事件属性，只保留并补全 HTTP(S) 资源 URL
- [x] RSS / JSON 来源自带正文在右侧 Reader 真正渲染，不再只显示 description placeholder
- [x] 正文链接仍通过 main `shell.openExternal` 打开，只允许 HTTP(S)；“原文”按钮升级为应用内 WebContentsView
- [x] Electron E2E：统一添加 RSS → 选择文章 → Reader 显示来源正文 → 原文按钮可用
- [x] Android 同语义全文候选链：微信 `#js_content` → WebsiteRule `contentSelectors` → JSON-LD/结构化数据 → Mozilla Readability
- [x] 正文候选统一清洗后重新评分：最低 20 分、WebsiteRule 有效候选优先、来源 bonus 最多保留 15 分
- [x] Android 5 类 `article-samples` 固定样本原样复制并通过：IT 规则、财经 JSON-LD、工程博客 Readability、WordPress 规则、发布平台 Readability
- [x] 静态全文抓取：15s 请求超时、2MB HTML 上限、提取成功后持久化到 `articles.full_content_html`，再次打开直接命中 SQLite 缓存
- [x] 动态正文 Chromium 兜底：仅静态正文失败且满足 Android 动态策略时启动；18s 总预算、全局单任务串行、验证页不作为正文
- [x] Android `EmbeddedRssContentPolicy`：微信 `/s` RSS 已携带足够完整正文时直接进入全文，避免再次访问微信触发验证
- [x] Reader 行为：Website / `isFullContent` 来源打开后自动全文；RSS 默认保留 Feed 正文并提供“全文”按钮手动提取
- [x] 稳定全文失败原因：NO_CONTENT / DYNAMIC_CONTENT / ACCESS_RESTRICTED / PAGE_UNAVAILABLE / INVALID_URL / NETWORK / UNKNOWN
- [x] Electron E2E：RSS 摘要 → 点击“全文” → 本地详情页 → Readability → SQLite 缓存 → Reader 显示真实全文
- [x] Windows `win-unpacked` 生产包实测全文 bridge / Readability：`ok=true`、`mode=full`、正文命中
- [x] 应用内原文：BrowserWindow `contentView` 挂载 `WebContentsView`，覆盖右侧 Reader 正文区域，不新开应用窗口
- [x] 原文安全边界：无 preload / Node、contextIsolation + sandbox、仅 HTTP(S)、权限拒绝、下载外置、关闭时显式销毁 webContents
- [x] 原文工具栏：后退 / 前进 / 刷新 / 外部浏览器 / 返回阅读；导航状态由 main 推送 Renderer
- [x] Reader ResizeObserver 持续同步 native view bounds，窗口尺寸及左侧栏收起/展开时原文页保持正确布局
- [x] Electron E2E：点击“原文”后本地详情页真实收到 WebContentsView 网络请求，再从 Reader 工具栏返回正文
- [x] Windows `win-unpacked` 生产包 smoke：设置 IPC / scheduler 状态 / WebContentsView 原文请求 / 关闭销毁均实跑通过
- [x] 阅读排版第一版：17px / 1.85 / 760px 默认，支持字号、行距、版心设置；完善标题、列表、引用、代码、表格、图片及图注样式

### Phase 5.5：设置界面

- [x] 右侧独立 Settings 页面，不使用临时 modal / Web 管理后台布局
- [x] 通用：系统 / 中文 / English 语言设置
- [x] 阅读：正文字号、行距、版心宽度，修改后即时作用于 Reader 并持久化
- [x] 同步：周期间隔、启动时同步、当前状态、上次同步、下次同步
- [x] 设置页按 Android 当前信息架构呈现 AI 阅读 / 翻译设置 / 文章过滤 / JSON 规则 / 网站解析规则 / 备份与恢复；Desktop 额外保留桌面通用设置；内容区固定在 Reader 可视范围并独立滚动
- [x] 左侧文章 / 来源列表固定占用剩余可视高度并独立滚动，Electron E2E 使用 30 篇文章验证真实滚动

### Phase 6：AI 与翻译

- [x] OpenAI Compatible Provider：Endpoint 兼容 `/v1` / `/chat/completions` / `/models`，支持 Bearer Key、模型发现、reasoning_content / reasoning / `<think>`
- [x] AI 摘要：迁移 Android 高信息密度 prompt、BRIEF / STANDARD / DETAILED、24k 正文裁切、按文章/Provider/模型/语言缓存
- [x] Reader AI 摘要：安全 Markdown 子集渲染，不把模型输出当 HTML；支持 reasoning 折叠与重新生成
- [x] 翻译 Provider：Microsoft Translator / DeepL / Google Cloud / DeepLX(DLX)；Google ML Kit 仅保留 Android 备份兼容，Desktop 设置 UI 不显示
- [x] AI 翻译目标：复用 OpenAI Compatible Provider，严格 JSON id 对齐、批次上下文、分段合并
- [x] 全文翻译：正文块抽取 / 重建，支持仅译文与双语对照；媒体节点保持，译文 HTML 仍走 Reader 安全边界
- [x] AI / Translation API Key 使用 Electron `safeStorage` 加密保存，不进入普通 SQLite / JSON 配置
- [x] AI / 翻译设置页的标题、说明、摘要长度说明与 Provider 说明按 Android 当前资源文案对齐；Desktop UI 不展示 Android ML Kit
- [x] 本地协议单测：OpenAI Compatible + Microsoft / DeepL / Google Cloud / DLX 全部使用 HTTP fixture 验证
- [x] Electron E2E：本地 RSS → Reader → OpenAI Mock 生成结构化摘要 → DLX Mock 全文翻译，真实 main/preload/Renderer 链路通过

### Phase 7：配置与迁移

- [x] WebsiteRule 全局管理：列表 / 启停 / 删除 / 导入 / 导出
- [x] JSON Rule 全局管理：列表 / 启停 / 删除 / 导入 / 导出
- [x] 文章过滤规则底层：KEYWORD / REGEX，全局或来源级作用域；来源规则优先于全局规则；设置页按 Android 当前页面仅新增全局规则，已有来源级规则仍可显示/恢复
- [x] 过滤规则真正接入 RSS / JSON / Website 入库前处理，不是仅管理 UI
- [x] Website 来源级解析策略底层：首选规则 / 自动规则缓存 / 动态 Chromium 开关；不擅自暴露到 Android 当前“网站解析规则”设置页
- [x] Website 规则 UI 与 Android 对齐：内部 `ithome-home` 规则不出现在规则列表
- [ ] RSSHub 设置 UI（Repository / IPC / health test 已完成）
- [ ] OPML 导入导出
- [x] Android 配置备份兼容：直接读写 `ConfigurationBackup schemaVersion=1`，订阅按 URL 合并、旧 feedId 重映射规则/偏好/RSSHub source URL
- [x] Android 加密凭据兼容：PBKDF2-HMAC-SHA256 210000 + AES-256-GCM + 相同 AAD；Android 当前 `ConfigurationBackupCryptoTest` 已实际运行通过
- [x] Desktop 配置备份：来源 / 分组 / 规则 / RSSHub / AI / 翻译 / 同步 / Desktop 阅读偏好；无密码时不含凭据，填写密码时加密凭据
- [x] 恢复采用“全量静态校验 + 密码解密成功后才开始写入”，不删除 Desktop 现有额外订阅或文章/已读/星标
- [x] Desktop 独有偏好写入 namespaced `preferences`；Android 对未知 key 验证放行且恢复时忽略，因此保持双向 envelope 兼容
- [x] Secret 加密：运行时 safeStorage；可移植备份内 AES-256-GCM
- [ ] AI 生成 Website / JSON 规则、规则在线试跑、模板保存 UI（Android 有此扩展能力，本轮未纳入核心规则管理）

### Phase 8：发布

- [x] Windows NSIS（当前为开发/未签名构建，安装包可生成）
- [ ] macOS DMG
- [ ] GitHub Actions
- [ ] Windows 签名
- [ ] macOS 签名 / notarization
- [ ] 自动更新

## 6. 每轮开发验收

Desktop 每轮至少执行：

```text
npm run typecheck
npm test
npm run build
```

涉及来源业务时，必须同时用 Android 已验证案例做行为对照；不能因为 TypeScript 实现更方便就改变原有业务顺序。

