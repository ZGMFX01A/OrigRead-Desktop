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

Windows 使用 NSIS，macOS 使用 DMG；Linux 纳入正式支持计划，至少提供 AppImage，并评估 DEB。动态网页与原文阅读直接使用 Electron 自带 Chromium，不再额外引入 JCEF/KCEF。

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
- [x] RSS 图标发现完全对齐 Android `BestIconFinder`：apple-touch-icon > SVG > PNG > ICO > GIF > JPG，同格式按字节大小；页面失败时回退标准根目录图标，Feed 自带 image 不再覆盖最终图标选择
- [x] RSSHub 路由目录：复制 Android 当前 `rsshub_routes.json` 数据资产，schema / routeCount 校验一致
- [x] RSSHub TypeScript matcher：host/path/query/动态参数/缺参/可选参数/安全约束与 Android 对照
- [x] RSSHub 16 个默认实例、最近成功优先、网络失败冷却降级、自定义实例持久化；冷却实例移到候选末尾而不是完全排除，避免短时网络抖动后数分钟内来源突然无法匹配
- [x] RSSHub Resolver：与 Android 当前实现统一为最多 5 个匹配路由、5s 单请求 / 12s 总预算；实例按最近成功/配置优先级**串行 fallback**，单实例内部才并发路由；不同实例的成功结果按 route key 合并，不再因某实例只成功一条路由就提前停止
- [x] RSSHub 本地路由发现与实例网络可用性解耦：总开关关闭、无启用实例、实例超时/失败时仍保留本地命中并返回 `unsupported / timeout / network_unavailable` 状态；添加来源 UI 单独展示 RSSHub 本地匹配，不再把网络失败表现成“没有路由”
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
- [x] Android 同序统一发现：显式 JSON 短路；否则 RSS → RSSHub → JSON → 静态 Website；仅所有静态候选均未通过评分时启动动态 Chromium。动态 Chromium 是最终兜底：空列表仍拒绝，但只要实际提取到有效且非全重复的 HTTP(S) 文章链接，标题率/日期率/数量等健康指标仅继续参与诊断与排序，不再二次硬否决
- [x] 添加来源 UI 两阶段闭环：检测 → 展示排序后的候选 → 用户选择 → 使用同一次主进程探测结果保存；RSSHub 多频道使用多选并支持一次全部订阅，普通 RSS/JSON/Website 仍互斥单选；用户界面不再展示技术评分和长 Feed URL，只保留频道名、类型、文章数和必要说明
- [x] 本地 Electron E2E：从添加来源 UI 输入 RSS → 统一检测 → 候选选择 → SQLite 订阅落库
- [x] `https://www.cls.cn/` 统一总入口真实公网验证：最终选中 RSSHub 热门榜，评分 90 / 13 篇，动态 Chromium 调用次数 0
- [x] RSS/Atom Android 行为对照测试
- [x] RSSHub Android 行为对照测试
- [x] JSON Android 行为对照测试
- [x] Website 行为对照测试

#### 2026-08-17 来源发现 UA 强制策略（由 Android 财联社事故同步）

Desktop **不能使用 Android Mobile UA，也不能把 `OrigRead/...`、Node/undici 默认 UA 或 Electron 默认 UA 用在普通网站 HTML 解析上**。桌面端本身就是桌面 Chromium 应用，所有“模拟普通浏览器打开网页”的链路统一使用当前 Electron 内置 Chromium 版本生成的标准 Desktop Chrome UA。

当前统一入口：`src/main/network/user-agent-policy.ts`，版本来自 `process.versions.chrome`，不再在各模块硬编码 `Chrome/151...`。

| Desktop 场景 | UA 规则 |
|---|---|
| RSS 来源发现中请求输入 HTML 页面 | Desktop Chrome UA |
| RSS 图标发现读取站点 HTML / 图标资源 | Desktop Chrome UA |
| Website 静态 HTML / 自动 DOM | Desktop Chrome UA |
| 隐藏 BrowserWindow 动态网页兜底 | Desktop Chrome UA |
| 全文提取的文章 HTML 请求 | Desktop Chrome UA |
| Reader 原文 `WebContentsView` | Desktop Chrome UA，并隐藏 Electron/App UA 特征 |
| Reader 本地页面加载的远程图片/媒体 | Desktop Chrome UA |
| AI 规则生成读取目标网页 | Desktop Chrome UA |
| RSSHub Feed/health、JSON API、AI Provider、翻译 Provider、GitHub 更新 | 按协议本身处理；**禁止为了“防 418”全局强塞浏览器 UA** |

财联社是固定回归样本：曾出现 App/Bot UA 返回 418、Android Mobile UA 虽返回 200 却被导向 `s.cls.cn/openapp/open.html`、Desktop Chrome UA 才得到真实 `www.cls.cn` 首页的情况。因此以后网络验收必须同时看 **status + final URL + 实际解析文章**，不能把 `HTTP 200` 当成“拿到了正确页面”。

UA 回归测试必须保证网页链路 UA 不含 `Electron`、`OrigRead`、`Mobile`、`wv` 标记，并跟随 Electron 实际 Chromium 版本。Windows 使用 Windows Desktop token；macOS/Linux 使用各自 Desktop token，不伪装成 Android。

2026-08-17 同步后的实测基线：

- 直接使用统一 Desktop UA 请求 `https://www.cls.cn/`：HTTP 200，final URL 仍为 `https://www.cls.cn/`，HTML 约 158 KB，并包含 `/detail/` 文章链接；不再进入 open-app 落地页。
- 真实构建后的 Electron 主进程通过 preload `discoverSource()` 请求财联社：本地匹配 RSSHub“电报”和“热门文章排行榜”两个频道；热门榜通过统一评分，13 篇、90 分并成为最高候选；电报虽然实例返回 20 条，但统一来源评分不合格，因此被归一为 `invalid_content` 而不是可订阅候选；同时 Website 静态解析 30 篇、86 分。
- 真实 Electron 添加来源 UI：显示“RSSHub 频道 / 已在本地匹配到 2 个频道”；热门榜显示“可订阅 · 13 篇文章”，电报显示“已匹配 · Feed 内容未通过质量检查”，普通候选区只显示 Website 30 篇，不再重复显示 RSSHub 候选。
- Vitest 全量：59 个 test files / 203 tests 全通过；`npm run build` 通过；`unified-add-source.spec.ts` Electron E2E 通过。

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
- [x] RSSHub 设置 UI：总开关、16 个内置/自定义实例列表、单实例启停、连通性测试、测试并添加、删除、恢复默认；复用现有 Resolver / health test
- [x] OPML 导入导出：对齐 Android `OpmlService`；顶层 Feed 进入默认分组、普通分组按 OPML 创建、`isDefault=true` 映射默认分组、重复 URL 跳过；支持可选导出 OrigRead 的通知/全文/浏览器附加属性；导入完成后触发一次全来源同步
- [x] Android 配置备份兼容：直接读写 `ConfigurationBackup schemaVersion=1`，订阅按 URL 合并、旧 feedId 重映射规则/偏好/RSSHub source URL
- [x] Android 加密凭据兼容：PBKDF2-HMAC-SHA256 210000 + AES-256-GCM + 相同 AAD；Android 当前 `ConfigurationBackupCryptoTest` 已实际运行通过
- [x] Desktop 配置备份：来源 / 分组 / 规则 / RSSHub / AI / 翻译 / 同步 / Desktop 阅读偏好；无密码时不含凭据，填写密码时加密凭据
- [x] 恢复采用“全量静态校验 + 密码解密成功后才开始写入”，不删除 Desktop 现有额外订阅或文章/已读/星标
- [x] Desktop 独有偏好写入 namespaced `preferences`；Android 对未知 key 验证放行且恢复时忽略，因此保持双向 envelope 兼容
- [x] Secret 加密：运行时 safeStorage；可移植备份内 AES-256-GCM
- [x] JSON / Website 规则页的本地 Markdown 教程、模板文件导入/导出、规则管理与 Website 在线规则测试已完成
- [ ] **AI 生成 JSON 规则 / AI 生成网站解析规则尚未完成。** 底层实验代码保留，但当前 Android 与 Desktop 用户入口统一置灰；点击仅提示“功能尚未完成”，在重新完成真实端到端稳定性与跨端验收前不得标记为可用
- [x] Android `source_catalog.json` 原样复制为 Desktop 资源：schemaVersion=1 / 752 feeds / 44 categories；发现来源支持本地搜索、分类筛选、数量显示和直接进入统一订阅流程

### Phase 8：发布

- [x] Windows NSIS（当前为开发/未签名构建；2026-08-17 13:24 已重新生成 `OrigRead-0.1.0-Windows-x64.exe`）
- [ ] macOS DMG
- [ ] Linux AppImage / DEB
- [ ] GitHub Actions
- [ ] Windows 签名
- [ ] macOS 签名 / notarization
- [x] 自动更新（Release 信息、手动/启动检查、当前平台资产选择、下载、安装启动与 Release 页面降级均已完成；真实公开 Release 网络 smoke 留到正式发布验收）

## 7. 当前剩余开发清单（以 Android 当前功能为产品基线）

以下 16 项作为 Desktop 收尾范围。已完成项保留在列表中用于最终 UI 一致性复核；后续不再把“底层已存在”误判成“用户功能已完成”。

1. [x] **发现来源**
   - 对齐 Android `SourceDiscoveryPage`，这是独立的内置来源目录功能，不等同于 URL 自动识别来源类型。
   - 读取 Android 同源目录数据（`source_catalog.json` 对应能力）。
   - 支持搜索、分类筛选、分类数量、来源数量、来源信息展示和直接订阅。
   - Desktop 入口可以按桌面交互优化，但不能丢失 Android 已有能力或改变功能含义。

2. [x] **JSON 规则完整功能**
   - JsonRule parser / Repository / 导入 / 导出 / 启停 / 删除底层与用户入口均已完成。
   - 本地使用教程、导出模板及状态反馈已完成。
   - [ ] AI 生成 JSON 规则仍属于未完成功能；入口保留但置灰，点击显示未完成提示。

3. [x] **网站规则完整功能**
   - WebsiteRule parser / Repository / 导入 / 导出 / 启停 / 删除底层与用户入口均已完成。
   - 本地使用教程、导出模板与在线规则测试已完成。
   - [ ] AI 生成网站解析规则仍属于未完成功能；入口保留但置灰，点击显示未完成提示。
   - 内部 `ithome-home` 规则继续按 Android 行为隐藏，不出现在用户规则列表。

4. [x] **RSSHub 设置**
   - Repository / Resolver / IPC / health test 与用户设置页均已完成。
   - 已对齐 Android：总开关、实例列表、实例启停、连通性测试、自定义实例添加、删除、恢复默认。

5. [x] **OPML 导入导出**
   - 已对齐 Android `OpmlService` 的导入、导出及重复 URL 跳过语义。
   - 顶层 Feed 进入默认分组；普通分组按 OPML 创建；`isDefault=true` 映射 Desktop 默认分组。
   - 默认导出包含 OrigRead 附加信息，也可选择仅导出通用 OPML 字段。
   - 已有 Core 单测覆盖解析/导出/重复 URL/默认分组/XML 实体；Renderer Smoke 覆盖 preload bridge、菜单入口和导出选项。真实系统文件选择器仍保留为人工验收项。

6. [x] **软件自动更新**
   - 已完成 Desktop GitHub Release 信息、手动检查、启动自动检查、版本比较、当前平台资产选择、下载安装/启动安装程序和 Release 页面降级。
   - 行为与 Android “检查更新”产品语义保持一致；私有仓库/无公开 Release、限流、网络失败和当前平台无资产不会误报“已是最新”。中国大陆 Release 二进制资产支持受限加速候选并始终回退 GitHub 官方地址。

7. [x] **阅读页面 UI 配置（背景色）**
   - 已支持跟随主题、纸白、暖白、米黄、淡绿以及任意 HEX 自定义背景色。
   - 正文、译文与 AI 摘要阅读区域统一应用；自定义明暗背景自动选择可读前景色并持久化。

8. [x] **深色适配**
   - 已完成浅色 / 深色 / 跟随系统主题。
   - `prefers-color-scheme` 运行时变化可即时更新，不仅启动时读取一次。
   - Reader、设置页、文章列表、来源发现、弹窗、AI 摘要和 WebContentsView 外层 UI 已统一适配。

9. [x] **UI 一致性检查**
   - 不要求 Desktop 100% 复刻 Android 布局。
   - 已按 Android 当前功能逐页补齐主要产品入口与语义缺口，包括 Reader 已读/未读、收藏、下一篇、全文/Feed 内容切换、AI/翻译入口、单来源设置、分组与来源筛选、通知和重载图标等。
   - 最终发布前仍保留“中英文可见性 + Windows/macOS/Linux 实机”发布级审计，不再作为独立功能开发项。

10. [ ] **自动打包**
    - GitHub Actions 自动构建覆盖 Windows、macOS 与 Linux。
    - 自动生成 Windows NSIS、macOS DMG 与 Linux AppImage；评估同时提供 DEB。
    - 后续签名 / notarization 在证书条件具备后接入同一发布流程。

11. [x] **项目 Git 发布页订阅**
    - Desktop 使用独立的 `ZGMFX01A/OrigRead-Desktop` Release 数据源。
    - 已展示版本、发布日期、Release Notes 和当前平台资产，并提供下载/安装与前往 Release 页面动作。
    - 仓库仍不可匿名访问或尚无公开 Release 时会明确降级，不在客户端内置 GitHub Token。

12. [x] **语言切换**
    - 默认跟随系统语言。
    - 支持中文与 English 手动切换。
    - 系统语言为中文时使用中文；所有非中文系统语言默认使用 English。
    - 已有 Locale 单测和 Settings → i18n 切换链；后续 UI 一致性检查仍需逐页确认所有新增功能均覆盖中英文文案。

13. [x] **阅读页文章内搜索**
    - 阅读正文时支持 `Ctrl + F` 打开文章内关键词搜索。
    - 高亮全部匹配项，并支持在上一个 / 下一个匹配项之间跳转。
    - 搜索范围以当前阅读内容为准，不与左侧文章列表搜索混用。

14. [x] **阅读字体与字体导入**
    - 阅读页支持切换正文使用的字体。
    - 支持导入用户本地字体，并在阅读字体列表中选择。
    - 字体配置仅影响 Reader 正文，不擅自改变应用 UI 字体。

15. [x] **文章朗读**
    - 朗读明确分为 **正文 / 翻译 / AI 摘要** 三个内容域。
    - Reader 主朗读入口默认朗读当前正文；当翻译已启用并正在显示译文时，主朗读入口只朗读译文，不再同时朗读原文。
    - AI 摘要区域内提供独立朗读按钮；摘要朗读不复用或抢占“正文 / 翻译”主入口的内容选择语义。
    - 优先评估并接入 Microsoft Edge / Chromium 可用的朗读语音能力，在 Windows 与 macOS 上提供可落地的桌面实现。
    - 正文/翻译主朗读和摘要朗读均需纳入统一生命周期控制，至少包含开始 / 暂停 / 继续 / 停止和可用语音选择；文章切换时必须安全停止旧内容。

16. [x] **AI 摘要阅读布局**
    - AI 摘要支持调整显示位置，而不是固定替换正文。
    - 支持左侧栏、右侧栏，以及吸附在阅读区上方 / 下方等布局。
    - 阅读过程中允许调整位置与占用空间；正文与摘要都必须保持可滚动、可阅读。

## 8. 2026-08-15 实机反馈回归修复

- [x] Website 订阅后第一次同步 HTTP 418 不再制造“已入库但添加弹窗报失败”的半状态；订阅成功与后续同步失败分离，并增加真实 418 Electron E2E。
- [x] Reader CSP 允许正文加载 HTTP / HTTPS 图片与媒体；增加 Website 来源“列表解析 → 订阅 → 点开文章 → 全文提取 → 图片真实加载”E2E。
- [x] 左侧文章列表和右侧 Reader 显式限制 Grid 高度链，实际 `scrollTop` 回归验证两边均可滚动。
- [x] 翻译目标语言改成本地草稿编辑，允许完整删除 `zh-CN` 后重新输入；失焦 / Enter 后再保存。
- [x] DeepL 简体中文目标码使用兼容性更高的 `ZH`，避免部分 DeepL 接口拒绝 `ZH-HANS`。
- [x] AI 与所有翻译 API Key 使用真实安全存储值作为密码输入内容，黑点数量与 Key 字符数一致，并增加眼睛显隐、显式保存 / 删除、保存状态提示。
- [x] 修复 AI / 翻译 Provider 修改其他字段时错误清空 Key 草稿的问题；AI Reader E2E 现在要求真实 Bearer Key 鉴权成功才能通过。
- [x] 左侧文章列表折叠改为当前会话状态：应用启动和配置恢复时始终展开，旧 `workspaceCollapsed=true` 会自动纠正；折叠后保留 34 px 明确侧轨和完整展开按钮，避免出现“文章列表像丢失”的假故障。Renderer E2E 覆盖持久化 true 后 reload 自动恢复。

## 9. 唯一剩余工作基线（2026-08-17 代码重新核对）

从本节开始，后续开发、验收和 checkpoint 统一以此清单为准。前面的 Phase 与 16 项清单用于保留开发历史；“接下来做什么”只看本节和第 10 节。

2026-08-17 本轮再次直接对照 `src/main`、`src/preload`、`src/renderer`、`src/shared`、Vitest、Playwright Electron E2E 与 `electron-builder` 配置核对，而不是根据旧勾选推断。确认来源发现/RSSHub/JSON/Website/动态 Chromium、单本地库同步、Reader/WebContentsView、AI/翻译、规则、OPML/配置备份、文章内搜索、字体导入、三域朗读、AI 摘要停靠、背景色/深色、Release/自动更新均已存在真实实现和自动测试。当前唯一未完成的产品功能仍是 A4 账户与自托管同步；其余未完成项属于跨平台构建、签名和发布级人工验收。

### A. 仍未开发的产品功能

1. [x] **Desktop Git Release 信息能力**
   - 使用 `ZGMFX01A/OrigRead-Desktop` 的 GitHub Release 数据。
   - 展示最新版本、Release Notes、发布时间和当前平台安装包；Release Notes 推荐用 GitHub 页面不可见的 `<!-- lang:zh -->` / `<!-- lang:en -->` 分段，客户端按当前软件语言选择；旧的可见语言标题和旧单语 Release 保持兼容。
   - `published_at` / `created_at` 面向用户统一格式化为 `yyyy-MM-dd`，不直接显示 ISO 时间戳。
   - 提供“直接下载当前平台安装包”和“打开完整 Release 页面”两个独立动作。
   - 当前仓库仍为私有库时，不在客户端内置 GitHub Token；匿名 GitHub API 返回 401/404 时明确归类为“仓库不可访问 / 可能仍为私有”，绝不误报“已是最新”。仓库公开后同一实现无需改架构即可直接工作。

2. [x] **手动检查更新完整闭环**
   - 设置页提供明确的“检查更新”。
   - 比较当前版本与最新 Release，正确处理“已是最新 / 有新版本 / 查询失败 / Release 没有当前平台资产”。
   - Windows 选择 NSIS、macOS 选择 DMG、Linux 优先选择 AppImage（可同时提供 DEB）。下载失败必须保留打开 Release 页的安全降级入口。

3. [x] **启动自动检查与更新设置**
   - 增加是否启动时自动检查更新的用户设置，默认行为与 Android 产品语义对齐。
   - 自动检查不得阻塞应用启动；失败只记录状态，不制造启动错误。
   - 下载、跳转、版本跳过 / 提醒策略在实现时统一确定，不把 GitHub 网络错误当成“没有更新”。
   - 中国大陆下载 GitHub Release 资产时优先使用可配置加速候选，失败自动回退 GitHub 官方地址；非大陆环境官方地址优先。加速只作用于 Release 二进制资产，不代理 GitHub API 或普通网页。

4. [x] **Release / 更新逻辑自动测试**
   - 使用本地 HTTP / GitHub API mock 覆盖版本比较、资产选择、日期格式化、无资产、限流/失败降级。
   - Renderer 至少覆盖“已是最新 / 有更新 / 查询失败”三种可见状态。
   - 当前私有仓库阶段以本地 GitHub API mock 完成自动验收；真实公开 GitHub Release 的最后一次网络 smoke 留到仓库公开 / 正式发版时执行，不属于 B 功能缺口。

5. [ ] **Desktop 账户与自托管同步**
   - Android 的 Local / FreshRSS / Google Reader / Fever 是真实账户与同步能力；Desktop 当前固定 `sourceAccountId: 1` 只是备份兼容字段，不是账户实现。
   - 在进入跨平台发布工程前完成当前本地资料库到默认 Local Account 的无损迁移，以及远端账户凭据校验、同步、切换、隔离、删除保护和 `safeStorage` 凭据保存。
   - 详细实现与验收边界见第 10 节 A4。

### B. 跨平台构建与发布工程

1. [ ] **GitHub Actions Windows + macOS + Linux 自动构建**
   - 当前仓库仍没有 `.github/workflows`。
   - 至少生成 Windows NSIS、macOS DMG、Linux AppImage artifact，并评估同时提供 DEB；为后续签名保留 secrets / signing 接入点。

2. [ ] **macOS DMG 实际构建**
   - `electron-builder.yml` 已配置 `dmg`，`package:mac` 脚本已存在；配置完成不等于平台验证完成。
   - 需要在 macOS runner / 实机真正生成 DMG。

3. [ ] **macOS 主链实机验证**
   - 至少验证启动、Renderer、来源添加/同步、Reader、WebContentsView、safeStorage、字体/文件选择器和 DMG 安装。

4. [ ] **Linux 构建与主链验证**
   - 增加 `electron-builder` Linux target 和 `package:linux`；至少产出 AppImage，并评估 DEB。
   - 在 Ubuntu runner / 实机验证启动、来源添加/同步、Reader、WebContentsView、字体/文件选择器、系统浏览器、通知和凭据安全存储。
   - 检查 Wayland / X11、HiDPI 缩放和系统主题跟随。

5. [ ] **正式签名链**
   - Windows code signing 尚未接入。
   - macOS signing / notarization 尚未接入；证书未具备前保持未完成，不伪造完成状态。
   - Linux 发布保留校验和 / 包签名接入位。

### C. 发布前人工验收

1. [ ] **Windows 当前安装包安装 / 卸载 / 重装 / 升级验证**
   - `release/OrigRead-0.1.0-Windows-x64.exe` 已于 2026-08-17 13:24 重新生成；当前缺口不再是“能否产出 NSIS”，而是安装、卸载、重装以及后续两个版本之间的升级路径人工验收。
   - 仍需实际执行 NSIS 安装、启动、卸载、重装，以及后续有两个版本时的升级路径验证。

2. [ ] **OPML 原生文件选择器人工验收**
   - Core、IPC bridge、菜单入口和导出选项已有自动测试。
   - 仍需真实选择 `.opml/.xml` 导入，并将导出的 `.opml` 给 Android OrigRead / 其他阅读器打开验证互操作。

3. [ ] **系统语言与主题跟随人工检查**
   - `system / zh / en` 与浅色 / 深色 / 跟随系统代码已完成并有自动验证基础。
   - 发布前在中文和非中文系统、浅色和深色系统环境各启动一次确认新增页面文案与视觉。

4. [ ] **最终中英文可见性审计**
   - 语言基础设施已完成；Release / 更新功能新增时必须同步中文和 English 文案。
   - 最终逐页确认不存在硬编码中文导致 English 模式漏翻。

5. [ ] **发布级全回归矩阵**
   - Windows：typecheck + unit + Electron E2E + NSIS 安装/卸载/重启持久化。
   - macOS：同等主链至少覆盖启动、来源、Reader、WebContentsView、safeStorage、DMG 安装。
   - Linux：至少覆盖启动、来源、Reader、WebContentsView、安全存储、AppImage（及 DEB 如提供）启动/安装。
   - Android 基线：Desktop 默认不修改 Android；如后续确实修改 Android，则执行对应 Android 回归。

### D. 工程收口 / 发布卫生

1. [ ] **形成下一次正式发布前 Git 基线**
   - 2026-08-17 本轮开始前 Desktop `main` 工作区已干净，Android 与 Desktop 为独立 Git root；当前工作区包含本轮功能修改，助手不得擅自 commit / push。
   - 发布前应确认工作区、tag 与 Release 源码完全对应，避免安装包与源码版本错位。

2. [ ] **确认正式版本号、构建产物命名与 Release 规则**
   - 当前 `package.json` 仍为 `0.1.0` 开发版本。
   - 正式 Desktop 1.0 发布前单独确认 tag、版本号、NSIS / DMG 命名和 Release 资产规则，不在普通功能开发中擅自改版本号。

### 当前自动回归基线

- `npm run typecheck`：通过。
- `npm test`：58 files / 195 tests 通过。
- `npm run build`：通过。
- Electron E2E：7 / 7 通过。
- 除 A4 账户与自托管同步外，当前已落地的来源、单本地库同步、Reader、AI、翻译、规则、OPML、背景/主题等主产品功能后续以防回归为主。

以上数字已于 2026-08-17 本轮重新执行确认：`npm run typecheck`、`npm test -- --run`、`npm run build`、`npm run test:e2e` 均成功，不沿用旧会话中的测试数量。

## 10. 后续按大项开发顺序

### 大项 A：产品功能闭环

- [x] A1 OPML 导入导出。
- [x] A2 Android ↔ Desktop UI / 产品语义一致性审计并修复明确缺口。
  - 已补 Reader 已读/未读、收藏、下一篇、AI 摘要按次 Provider/模型/长度、翻译目标选择、全文 ↔ Feed 内容双向切换。
  - 已补单来源设置：重命名、URL、分组/新建分组、全文/浏览器互斥、来源级过滤、Website 候选、动态渲染、清空文章、删除来源、重载图标。
  - 来源设置按来源类型收敛：已确认 RSS/Atom 不再显示“阅读”页签及全文抓取/浏览器预设等冗余选项；Website/JSON 继续保留各自需要的读取配置。
  - RSSHub 多实例回退与 Android 对齐为“按优先级排序、实例串行 fallback、单实例内部有限路由并发、最多 5 个路由、12 秒总预算”；不同实例可以分别补齐不同路由，最终按 route key 取并集；冷却实例仅降级到末尾而非完全排除。公共实例对同一路由存在明显实时波动，因此来源发现不再依赖单一实例或单一成功时序。
  - 2026-08-17 再次收敛来源设置的信息架构：RSS/Atom 完全不显示“阅读”页签；Website/JSON 的阅读配置改成用户可理解的“在原读内阅读 / 浏览器打开”二选一，只有 Website 且选择原读内阅读时才显示次级“抓取完整正文”开关。底层 `isFullContent / isBrowser / dynamicRendering` 语义与互斥规则保持不变。
  - `isBrowser` 已对齐 Android：点击文章直接标记已读并外部打开，不进入 Reader。
  - `isNotification` 已接真实 Electron Notification，手动和周期同步统一从 `SourceSyncService` 触发，仅通知本轮新增文章。
  - 软件更新归入 B、背景色/深色归入 D；不为完成 A2 提前混做后续大项。
- [x] A3 RSS `BestIconFinder` 行为补齐。
  - 对齐 Android：apple-touch-icon > SVG > PNG > ICO > GIF > JPG，同格式按字节大小；页面失败时回退标准根目录图标。
  - RSS 发现不再以 Feed 自带 image 作为最终图标；来源列表显示持久化图标并在加载失败时回退 RSS 图标。
  - A2/A3 验收：`npm run typecheck` / `npm test`（50 files / 155 tests）/ `npm run build` / Electron E2E（6/6）通过。
- [ ] A4 **账户与自托管同步**（E 发布工程前置项）。
  - Android 的“账户”不是展示页：Local / FreshRSS / Google Reader / Fever 均连接真实 `AccountService + RssService`，包含凭据校验、同步、切换、删除和账户级数据隔离。
  - Desktop 当前没有 Account domain；配置备份中的固定 `sourceAccountId: 1` 仅用于 Android schema 兼容，不能视为账户功能，更不能先补一个不可工作的假 UI。
  - 实现时先把当前单本地资料库无损迁移为默认 Local Account，再增加 FreshRSS / Google Reader / Fever；Fever 在 UI 中继续明确“旧协议 / 不推荐”，但若保留入口就必须真实可用。
  - 账户凭据必须进入 `safeStorage`，不得写入普通 SQLite/JSON；Feed / Group / Article 查询、同步任务、通知、备份恢复均必须绑定当前账户，并覆盖切换账户后 Reader/来源列表不会串数据。
  - A4 完成验收至少包含：旧库迁移、Local 默认账户、三类远端凭据校验、一次真实/Mock 同步、账户切换隔离、删除保护、备份兼容和 Electron E2E。

### 大项 C：阅读效率增强

- [x] C1 Ctrl + F / Cmd + F 文章内搜索：当前 Reader 内容限定、全部高亮、上一项/下一项和快捷键处理完成。
- [x] C2 Reader 字体切换与本地字体导入：内置字体 + TTF / OTF / WOFF / WOFF2 导入、持久化、删除和 Reader-only 应用完成。
- [x] C3 文章朗读：正文 / 翻译 / AI 摘要三域完成；主入口默认正文、译文正在显示时仅朗读译文；摘要窗口独立朗读按钮；暂停 / 继续 / 停止 / 系统语音选择完成。
- [x] C4 AI 摘要布局：替换正文 / 左 / 右 / 上 / 下和 220～640 px 面板尺寸调整完成，正文与摘要独立滚动。
  - Header 改为按摘要面板自身宽度响应：宽面板保持单行紧凑布局，窄侧栏才自动拆成两行；上下停靠不再被强制撑高。
  - 常驻“面板尺寸”Footer 已移除，尺寸调节改为 Header 内按钮 + 紧凑浮层滑块；上下停靠不再出现突兀的整条控制栏。
  - AI 摘要视觉统一为轻科技蓝：蓝白面板层级、浅蓝渐变 AI 图标、轻阴影和蓝色模式徽标；Android 阅读底栏与 Android AI 摘要面板同步使用同一组科技蓝渐变图标语义。
  - AI 摘要任务支持显式停止：Renderer 立即恢复可操作状态，Main 通过 `AbortController` 真正中止模型 HTTP 请求，并使用任务序列避免已取消请求的迟到结果覆盖当前摘要；重新生成时停止会保留上一份成功摘要。
- DeepL 服务测试与额度查询已彻底拆分：测试连接只发送翻译请求，只有显式点击“查询额度”才访问 `/usage`；Desktop 使用独立 Main IPC / preload API，Android 不再在进入页面或保存 Key 时自动查询额度。
- 当前回归基线：`npm run typecheck` / `npm test`（56 files / 172 tests）/ `npm run build` / Electron E2E（6/6）通过；Android `:app:compileGithubDebugKotlin` 通过，摘要 Prompt、更新日志本地化、GitHub Release 下载候选等定向单测通过（JDK 17）。

### 2026-08-17 摘要 / 翻译 / 更新与平台范围收口

- [x] Android 与 Desktop AI 摘要不再用同一份“技术报告式”长模板覆盖所有文章：同一次请求先在内部判断产品发布、普通新闻、评测、教程、科研/行业报告、深度分析等主类型，再按类型选择信息骨架与压缩强度；标准档加入按正文长度计算的绝对输出上限，产品/快讯要求进一步短于该上限。
- [x] AI 摘要缓存版本升级，旧版偏长缓存安全失效，避免 Prompt 已更新但用户仍继续命中旧摘要。
- [x] AI 摘要在上述分类基础上进一步改为“摘要价值判断 → 文章形态 × 内容领域 → 对应压缩策略”，而不是继续平铺金融快讯、影视快讯、汽车快讯等无限类型。文章形态固定为 flash / release / news / review / guide / research / report / analysis / opinion / interview / other；领域只调整需要优先抓取的事实槽位，不改变文章形态本身的摘要结构。
- [x] Android / Desktop 都增加保守的本地摘要价值判断：只对明显已经高度浓缩、且没有标题层级 / 列表 / 引用 / 代码等结构的极短正文直接返回 `NOT_NEEDED`，不会调用 AI；短但结构化的教程、研究、报告、更新说明仍继续进入原有复杂文章摘要链，避免单纯按字数误杀。
- [x] 边界文章不额外增加一次分类请求，而是在原摘要请求第一行返回不可见元数据，携带 `shouldSummarize + form + domain + reason`；协议已版本化为 `origread-summary-v1` + `"v":1`，解析端继续兼容旧 `origread-summary`，OpenAI Compatible 模型不遵循或元数据损坏时仍 fail-open 为普通 Markdown 摘要，不为结构化输出牺牲第三方 Provider 兼容性。`NOT_NEEDED` 作为成功结果缓存并在 UI 明确显示，不当成错误。
- [x] 摘要长度不再由“正文比例 + 会强行把短文抬长的固定最小值”决定：BRIEF / STANDARD / DETAILED 仍保持约 25% / 30% / 45% 的模式语义，但最终硬上限同时受模式绝对上限、原文有效正文约 48% 压缩上限和文章形态上限约束。200～300 字正文不会再因为 180 / 300 字旧下限被硬写成长摘要。
- [x] **速览 / 均衡 / 深入三档继续是独立的用户摘要模式，而不是被文章形态分类替代**：BRIEF 保持单段高密度、复杂文只抓结论与最关键依据；STANDARD 保留主要事实和复杂文必要的方法/限制；DETAILED 继续允许评测测试条件、教程步骤、科研方法/样本/数据/限制、深度分析论证链等多层结构。文章形态 × 领域只决定“抓什么和怎样组织”，三档决定“压缩到什么程度”，并且档位仍参与缓存键，互不串缓存。
- [x] **原有复杂文章摘要能力明确保留并加强**：科研 / 行业报告继续保留研究问题、方法或样本、关键数据、结论与限制；深度分析 / 观点保留核心主张、证据、论证链与边界；教程保留前提、关键步骤与风险；评测保留测试条件、实测数据、优缺点和结论。STANDARD 不再因为追求短而削掉必要方法/限制，DETAILED 仍允许结构化多层摘要。
- [x] 摘要与扩展分析彻底分离：Prompt 明确禁止使用原文外知识补背景、历史、行业影响、未来走势、因果解释或作者未写出的结论，并把正文内要求模型改变任务的文字视为不可信内容；摘要只负责压缩原文。
- [x] 摘要正文预处理补齐并约束 HTML 表格：Android / Desktop 都保留表格真实行结构；小表完整进入摘要，大表单表最多约 6000 字符并从整张表范围等距抽取代表行，而不是永远只取前若干行；列数、单元格和单行也有独立预算，并明确标记未展示数据，防止巨型表格挤掉正文。上一轮表格转 `pre` 后被通用空白归一化压平换行的问题也已修复。
- [x] `NOT_NEEDED` 缓存正文绑定经过代码审计和回归确认，无需新增一套 fingerprint 持久化结构：Android 缓存键已有正文 SHA-256，Desktop 缓存键及 latest 索引校验实际参与摘要的预处理正文 hash；同一 articleId 从短 Feed Content 切换到长 Full Content 后旧 `NOT_NEEDED` 自动失效。Desktop 已增加“短 Feed → NOT_NEEDED → Full Content → 正常调用 Provider”真实服务级测试。
- [x] 摘要短文判断和比例预算从简单字符数改为 Android / Desktop 同定义的跨语言 `effectiveLength`：CJK 字符约 1 单位，其他 Unicode 字母/数字词约 2 单位，标点/空白不计。这只是稳定启发式而非 tokenizer，用于避免英文单词平均字符更长导致的系统性高估；原 140 / 280 / 420 阈值和 25% / 30% / 45% / 48% 业务关系保持不变。
- [x] AI 层 `shouldSummarize=false` 明确改为高置信度动作：只有高度确定摘要只能同义复述时才允许 false；任何疑问必须 true，且不得因为文章是 flash、篇幅较短或接近阈值就直接 false。没有增加第二次 AI 判断请求，也没有引入不可靠且当前 UI 不消费的数值 confidence。
- [x] 本轮摘要第三轮审计验收：Desktop `npm run typecheck` 通过、`npm test` 58 files / 191 tests 通过、production build 通过、Electron E2E 7 / 7 通过；服务级测试覆盖正文 fingerprint 失效与 120×12 巨表预算，E2E 同时覆盖正常长文 AI 请求和极短快讯零 Provider 请求。Android `AiSummaryPromptTest` + `AiSummaryPolicyTest` 定向回归通过（JDK 17，`BUILD SUCCESSFUL`）。
- [x] Android / Desktop 更新日志推荐使用 GitHub 页面不可见的 `<!-- lang:zh -->` / `<!-- lang:en -->` 双语分段，并按当前 App 界面语言选择；旧的 `## 中文` / `## English` 可见标题和旧单语 Release 继续兼容。
- [x] Android 中国大陆 GitHub Release 下载增加受限加速候选：只改写 `/releases/download/` 二进制资产，镜像失败自动回退 GitHub 官方地址；非大陆环境保持官方直连。OrigRead 内置 Release 文章的 APK 下载入口复用同一规则。
- [x] Desktop 禁用 F12 / Ctrl+Shift+I；正式构建同时关闭 `webPreferences.devTools`，开发态仅保留程序化调试能力。
- [x] Android 与 Desktop 译文标题下保留弱化的原标题，不再让译题完全覆盖来源标题。
- [x] Android 与 Desktop 在用户尚未保存目标语言时，AI 摘要输出语言和翻译目标语言默认跟随操作系统语言；已有用户设置不被系统语言变化覆盖。
- [x] Linux 已进入 Desktop 正式支持计划：至少 AppImage，评估 DEB，并纳入 GitHub Actions、Wayland/X11、HiDPI、WebContentsView、安全存储及发布级回归范围。

### 大项 D：外观系统

- [x] D1 阅读背景色：支持跟随主题 / 纸白 / 暖白 / 米黄 / 淡绿预设，以及任意 HEX 自定义颜色；正文、译文和 AI 摘要阅读区域统一应用并持久化，自定义亮/暗背景自动选择可读前景色。
- [x] D2 全局浅色 / 深色 / 跟随系统主题：支持运行时系统明暗变化监听，设置即时生效并纳入 Desktop 配置备份。
- [x] D3 全页面和 WebContentsView 外层视觉回归：Workspace、文章列表、Reader、设置、来源发现、规则/Provider/工具弹窗和 AI 摘要补齐深色视觉；进入原文 WebContentsView 后应用外层主题保持不变。

### 2026-08-16 导航与 Android AI 设置收口

- [x] Desktop 文章导航不再把“来源”作为与“全部 / 未读 / 星标”互斥的第四个 Tab；重构为“阅读范围 × 文章状态”两个正交维度。
  - 阅读范围支持：全部来源 / 分组 / 单来源。
  - 文章状态支持：全部 / 未读 / 星标，并始终在当前范围内生效。
  - 来源选择器展示分组、来源文章数和未读数；选择来源或分组后回到文章列表，不重置文章状态。
  - 已读文章在“全部”列表中降权显示，未读文章继续保持标题强调。
  - 删除旧 `active-source-filter` 展示链和死 CSS，避免继续在旧四 Tab 结构上叠补丁。
- [x] Android AI 设置在配置两个及以上 Provider 时显示轻量提示：已配置服务数量、当前正在编辑的服务，以及通过上方选择器切换；单 Provider 时保持原有简洁布局。

### 2026-08-16 Reader 图片与 AI 摘要真实机器反馈收口

- [x] Desktop Reader 远程图片请求与 Android 行为对齐：本地 `file://` Reader 缺少 HTTP Referer 时，为图片请求补目标图片 origin；原文 WebContentsView 已有真实 HTTP(S) Referer 时保持原样，不关闭 `webSecurity`。E2E 使用“无正确 Referer 即 403”的图片 fixture 验证通过。
- [x] 文章列表中的 `description` 明确为“来源提供的文章简介/预览”，不再使用容易与 AI 摘要混淆的“正文摘要”空态文案；AI 摘要保持独立数据语义。
- [x] AI 摘要缓存增加“当前文章最近一次成功摘要”索引：临时切换 Provider / Model / 摘要档位生成成功后，普通 AI 入口可跨页面重载直接复用；文章标题或正文变化时旧索引自动失效，显式重新生成仍按本次选定参数请求。
- [x] AI 摘要参数弹窗改为非阻塞提交：点击生成后立即关闭弹窗，后台生成期间正文继续可读。
- [x] AI 摘要增加真实阶段可观察性：准备文章内容 → 等待 AI 服务 → 整理并保存，并显示已等待秒数；不展示无法从非流式 Provider 获得的虚假百分比。已有摘要重新生成时旧摘要继续可见并显示进度条。

### 大项 B：发布页与自动更新

- [x] B1 Desktop Git Release 信息与当前平台安装包选择；Release Notes 使用隐藏语言标记按当前软件语言选择，旧单语 / 旧标题格式兼容。
- [x] B2 手动“检查更新”完整闭环：已是最新 / 有更新 / 私有仓库或无公开 Release / API 限流 / 网络失败 / 当前平台无资产均有独立状态。
- [x] B3 启动自动检查开关、版本比较、下载/跳转、错误降级；默认与 Android 一致为开启，后台检查不阻塞启动；中国大陆优先 GitHub Release 加速候选并始终保留 GitHub 官方地址回退，不代理 GitHub API 或普通网页。
- [x] B4 相关网络与版本逻辑单测 + Electron E2E mock 完成；覆盖隐藏双语日志、SemVer、平台资产、国内代理失败回退官方、有更新、已最新和私有仓库 404。

**B1 → B4 已完成。下一步先完成 A4 账户与自托管同步，再进入大项 E 跨平台构建与正式发布。** 当前私有仓库不阻塞 B 的开发完成；公开仓库后的真实 Release 网络 smoke 留到正式发布验收。

### 2026-08-17 E 前产品收口

- [x] 设置导航重新排序：软件更新固定为最后一项；新增“关于与支持”，展示当前 Desktop 版本以及 Android / Desktop 两个独立项目入口。
- [x] “关于与支持”第二轮视觉/信息架构收口：Desktop 使用 OrigRead Logo 替换通用问号，标题明确为“关于 OrigRead / 原读”，内容最大宽度收至约 760px；“当前客户端”独立成卡片，用版本/平台 Badge 展示状态，并提供“检查更新 / 查看 Release”；Android / Desktop 仓库使用显示器/手机平台图标区分；新增真实快捷键速查与 Desktop GitHub Issues 反馈入口，兼容深色主题与窄窗口。Desktop 仓库当前没有 `LICENSE` 文件，因此不创建指向不存在资源的“开源协议”按钮；正式发布前确定 Desktop License 后再补。
- [x] Desktop 更新链补强大陆网络识别：不再只匹配精确 `zh-CN`，而是按系统 locale 的 `CN` 地区判断，因此 `en-CN`、`zh-Hans-CN` 等也会优先尝试 Release 二进制加速；加速失败自动回退 GitHub 官方地址。GitHub Release 元数据仍使用官方 API，不把版本判断交给第三方代理。
- [x] Android“提示和支持”页增加 OrigRead 多平台说明，并分别提供 Android / Desktop GitHub 项目入口；两个客户端继续独立发布，不制造“一个安装包覆盖所有平台”的误导。
- [x] Android“提示和支持”第二轮视觉收口：去掉标题右上角错位版本角标，Hero Logo 从 240dp 收至 204dp，并统一“原读 / OrigRead / 来源优先的阅读器 / v版本”中心轴；多平台介绍增加水平内边距和居中排版，Android / Desktop 两个入口改为带手机/电脑平台图标的等宽轻量卡片，GitHub 图标仅作为仓库语义提示；删除上下 `SpaceAround` 造成的断层式大留白，并增加轻量开源页脚。
- [x] Desktop 无文章阅读区删除“Electron 重构进行中 / DB ready”等开发态占位信息，改为正式产品空态：资料库为空时引导添加/发现来源；当前筛选无结果时提示调整范围；有文章未选择时保持极简留白并显示真实阅读快捷键。
- [x] Desktop 阅读快捷键二次收口：`← / →` 控制上一篇/下一篇（`K / J` 继续作为兼容快捷键），`↑ / ↓` 控制正文上下滚动；`,` / `.` 循环切换 AI 摘要位置，`- / +` 缩小/放大停靠摘要面板；`M` 已读/未读、`S` 收藏、`U` 原文、`[` 折叠/展开工作区保持不变，`Ctrl/Cmd+F` 继续只搜索当前 Reader 正文。无文章 Reader 空态与“关于与支持”均同步展示这组真实快捷键。
- [ ] **在进入 E1 前先完成 A4 账户与自托管同步。** 这是本轮重新对照 Android 后发现的真实产品能力缺口，优先级高于打包流水线。

### 2026-08-18 添加来源进度、性能与未完成功能收口

- [x] **添加来源增加真实阶段进度。** main `SourceDiscoveryService` 向 Renderer 上报 `RSS / RSSHub / JSON / 静态 Website / 动态 Chromium / 候选评分` 的 running/completed 状态，preload 只桥接带 `requestId` 的窄事件；弹窗显示正在执行的阶段与已用秒数，不伪造百分比。请求 ID 使用同步 ref 过滤，避免 React 状态更新前丢掉最早的阶段事件。
- [x] **Desktop 添加来源确实存在额外等待，不只是 UI 看起来像卡死。** 旧实现将 RSS → RSSHub → JSON → Website 串行执行；改造后四条互不依赖的静态探测并行启动，候选仍按 Android 固定来源顺序装配，动态 Chromium 仍只在全部静态候选失败后启动，因此仅优化等待时间，不改变业务优先级。
- [x] **RSSHub 性能参数重新以 Android 当前代码为准。** Desktop 从“最多 8 路由 / 15s 总预算”纠正为“最多 5 路由 / 12s 总预算”，实例仍按优先级串行 fallback，单实例内部才并发有限路由。财联社真实 Electron 主链在同一轮调试环境中，优化前一次耗时 `15018ms`，其中 Website `326ms`、JSON `194ms`、RSS `893ms`，RSSHub 占满约 `15017ms`；对齐后一次完整发现为 `6320ms`，后续真实 UI 一次从点击到 RSSHub 结果出现约 `5593ms`。公共实例有实时波动，所以这些数字只作为本轮性能证据，不作为固定 SLA。
- [x] 财联社优化后仍保持正确业务结果：本轮样本中“热门文章排行榜”可订阅 13 篇；“电报”实例返回 20 条但统一来源评分不合格，因此显示“已匹配 · Feed 内容未通过质量检查”；Website 同时可解析 30 篇。性能优化没有绕过统一评分，也没有牺牲 RSSHub 本地路由展示。
- [x] **阅读快捷键改为桌面阅读器语义。** `↑/↓` 滚动正文，`←/→` 上一篇/下一篇；J/K 继续保留兼容。`,` / `.` 向前/向后循环 `replace → left → right → top → bottom` 摘要位置，`- / +` 以 20px 调整停靠摘要面板并保持 220～640px 边界。快捷键已经同步到无文章 Reader 空态和“关于与支持”。
- [ ] **AI 生成 JSON 规则 / AI 生成网站解析规则未完成。** Android 与 Desktop 的菜单入口现在统一视觉置灰，但仍允许点击以立即显示“功能尚未完成”的说明；底层早期实验 Service/预览代码保留，不能因为代码存在就继续计入产品完成度。重新开放前必须补足真实来源、真实 Provider、失败恢复、保存后同步和双端一致性验收。
- [x] 本轮新增并行探测/进度单测通过；Desktop 全量 Vitest **59 files / 204 tests**、`npm run typecheck`、`npm run build`、统一添加来源 Electron E2E（含方向键正文滚动与左右切篇）均通过。Android `:app:assembleGithubDebug` 使用 JDK 17 构建通过。

### 大项 E：跨平台构建与正式发布

- [ ] E1 GitHub Actions Windows / macOS / Linux 自动构建：Windows 产出 NSIS，macOS 产出 DMG，Linux 至少产出 AppImage，并评估同时提供 DEB。
- [ ] E2 当前 Windows NSIS 安装 / 卸载 / 重装验证；`release/OrigRead-0.1.0-Windows-x64.exe` 已于 2026-08-17 13:24 重新生成，不再重复把“生成安装包”列为缺口。
- [ ] E3 macOS DMG 构建与实机主链验证。
- [ ] E4 Linux 适配与实机主链验证：启动、来源发现/同步、Reader、WebContentsView、字体/文件选择器、系统浏览器、通知与凭据安全存储，并确认 Wayland/X11 下窗口和缩放行为。
- [ ] E5 Windows 签名、macOS signing/notarization（证书具备后）；Linux 保留包校验/签名发布位。
- [ ] E6 最终中英文、Windows/macOS/Linux 安装与启动、升级、备份恢复、来源/Reader/AI/翻译全回归。

## 6. 每轮开发验收

Desktop 每轮至少执行：

```text
npm run typecheck
npm test
npm run build
```

涉及来源业务时，必须同时用 Android 已验证案例做行为对照；不能因为 TypeScript 实现更方便就改变原有业务顺序。

