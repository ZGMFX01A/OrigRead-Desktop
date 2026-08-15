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
- [x] RSSHub 设置 UI：总开关、16 个内置/自定义实例列表、单实例启停、连通性测试、测试并添加、删除、恢复默认；复用现有 Resolver / health test
- [x] OPML 导入导出：对齐 Android `OpmlService`；顶层 Feed 进入默认分组、普通分组按 OPML 创建、`isDefault=true` 映射默认分组、重复 URL 跳过；支持可选导出 OrigRead 的通知/全文/浏览器附加属性；导入完成后触发一次全来源同步
- [x] Android 配置备份兼容：直接读写 `ConfigurationBackup schemaVersion=1`，订阅按 URL 合并、旧 feedId 重映射规则/偏好/RSSHub source URL
- [x] Android 加密凭据兼容：PBKDF2-HMAC-SHA256 210000 + AES-256-GCM + 相同 AAD；Android 当前 `ConfigurationBackupCryptoTest` 已实际运行通过
- [x] Desktop 配置备份：来源 / 分组 / 规则 / RSSHub / AI / 翻译 / 同步 / Desktop 阅读偏好；无密码时不含凭据，填写密码时加密凭据
- [x] 恢复采用“全量静态校验 + 密码解密成功后才开始写入”，不删除 Desktop 现有额外订阅或文章/已读/星标
- [x] Desktop 独有偏好写入 namespaced `preferences`；Android 对未知 key 验证放行且恢复时忽略，因此保持双向 envelope 兼容
- [x] Secret 加密：运行时 safeStorage；可移植备份内 AES-256-GCM
- [x] JSON / Website 规则页补齐 Android 当前用户功能：本地 Markdown 教程、AI 生成候选、真实本地试跑、失败后最多修复一次、预览确认后保存、模板文件导出；Website 额外支持在线规则测试
- [x] Android `source_catalog.json` 原样复制为 Desktop 资源：schemaVersion=1 / 752 feeds / 44 categories；发现来源支持本地搜索、分类筛选、数量显示和直接进入统一订阅流程

### Phase 8：发布

- [x] Windows NSIS（当前为开发/未签名构建，安装包可生成）
- [ ] macOS DMG
- [ ] GitHub Actions
- [ ] Windows 签名
- [ ] macOS 签名 / notarization
- [ ] 自动更新

## 7. 当前剩余开发清单（以 Android 当前功能为产品基线）

以下 16 项作为 Desktop 收尾范围。已完成项保留在列表中用于最终 UI 一致性复核；后续不再把“底层已存在”误判成“用户功能已完成”。

1. [x] **发现来源**
   - 对齐 Android `SourceDiscoveryPage`，这是独立的内置来源目录功能，不等同于 URL 自动识别来源类型。
   - 读取 Android 同源目录数据（`source_catalog.json` 对应能力）。
   - 支持搜索、分类筛选、分类数量、来源数量、来源信息展示和直接订阅。
   - Desktop 入口可以按桌面交互优化，但不能丢失 Android 已有能力或改变功能含义。

2. [x] **JSON 规则完整功能**
   - 当前已有 JsonRule parser / Repository / 导入 / 导出 / 启停 / 删除等底层能力，但整个用户功能仍视为未完成。
   - 继续补齐 Android 当前页面已有的使用教程、AI 生成 JSON 规则、导出模板，以及对应交互与状态反馈。

3. [x] **网站规则完整功能**
   - 当前已有 WebsiteRule parser / Repository / 导入 / 导出 / 启停 / 删除等底层能力，但整个用户功能仍视为未完成。
   - 继续补齐 Android 当前页面已有的使用教程、AI 生成网站解析规则、导出模板、测试网站解析规则。
   - 内部 `ithome-home` 规则继续按 Android 行为隐藏，不出现在用户规则列表。

4. [x] **RSSHub 设置**
   - 底层 Repository / Resolver / IPC / health test 已完成，但用户设置页尚未完成。
   - 对齐 Android：总开关、实例列表、实例启停、连通性测试、自定义实例添加、删除、恢复默认。

5. [x] **OPML 导入导出**
   - 已对齐 Android `OpmlService` 的导入、导出及重复 URL 跳过语义。
   - 顶层 Feed 进入默认分组；普通分组按 OPML 创建；`isDefault=true` 映射 Desktop 默认分组。
   - 默认导出包含 OrigRead 附加信息，也可选择仅导出通用 OPML 字段。
   - 已有 Core 单测覆盖解析/导出/重复 URL/默认分组/XML 实体；Renderer Smoke 覆盖 preload bridge、菜单入口和导出选项。真实系统文件选择器仍保留为人工验收项。

6. [ ] **软件自动更新**
   - Desktop 自动检查更新、提示更新、下载安装/跳转发布页等完整用户流程尚未实现。
   - 行为与 Android 已有“检查更新”产品语义保持一致，桌面端仅做平台必要适配。

7. [ ] **阅读页面 UI 配置（背景色）**
   - 在现有字号 / 行距 / 版心设置基础上，补齐阅读背景色等 Android 已有阅读外观配置。

8. [ ] **深色适配**
   - 完成全局深色主题。
   - 支持跟随系统变化，不仅是启动时读取一次。
   - Reader、设置页、文章列表、弹窗、WebContentsView 外层 UI 都要统一适配。

9. [ ] **UI 一致性检查**
   - 不要求 Desktop 100% 复刻 Android 布局。
   - 必须逐页核对 Android 当前功能，确保不丢入口、不丢功能、不擅自改变功能描述或业务含义。
   - 按钮位置、页面排版、桌面交互方式允许优化，但产品语义以 Android 当前实现和资源文案为准。

10. [ ] **自动打包**
    - GitHub Actions 自动构建至少覆盖 Windows 与 macOS。
    - 自动生成 Windows 安装包与 macOS DMG 产物。
    - 后续签名 / notarization 在证书条件具备后接入同一发布流程。

11. [ ] **项目 Git 发布页订阅**
    - 对齐 Android 已有 Git 发布页订阅功能，但 Desktop 使用独立的 `ZGMFX01A/OrigRead-Desktop` 发布地址。
    - 展示 Desktop Release 信息。
    - 提供直接下载安装包按钮。
    - 提供前往 Git 发布页按钮。

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

## 9. 唯一剩余工作基线（2026-08-15）

从本节开始，后续开发、验收和 checkpoint 统一以此清单为准。上面的 Phase 与 16 项清单用于保留开发历史，不再单独推导“还有什么没做”。任何项目只有同时满足“实现完成 + 所需自动测试通过 + 对应平台验证完成”后，才从本节移除。

### A. 尚未开发 / 尚未形成完整用户功能

1. [ ] **软件自动更新**
   - 自动检查、用户提示、下载安装或安全跳转 Release 的完整流程尚未实现。
   - 与 Desktop 独立仓库 Release 版本比较、失败降级和更新设置仍待开发。

2. [ ] **Desktop Git Release 页面能力**
   - 使用 `ZGMFX01A/OrigRead-Desktop` Release 数据。
   - 展示版本与发布时间、直接下载当前平台安装包、打开完整 Release 页面。

3. [ ] **阅读背景色配置**
   - 当前 Reader 只有字号、行距、版心宽度；背景色配置模型、持久化与 UI 尚未实现。

4. [ ] **全局深色主题 / 跟随系统主题**
   - 当前没有 theme 状态和 `prefers-color-scheme` 跟随链。
   - Reader、设置页、列表、弹窗和 WebContentsView 外层 UI 均需统一适配。

5. [x] **阅读页 Ctrl + F 文章内搜索**
   - `Ctrl + F` / `Cmd + F` 只搜索当前 Reader 内容，不混入左侧文章列表或应用 UI。
   - 已实现全部匹配高亮、当前项定位、上一项/下一项、Enter / Shift+Enter 和 Escape 关闭；译文模式搜索当前译文。

6. [x] **阅读字体与本地字体导入**
   - 内置默认 / 无衬线 / 衬线 / 等宽四档 Reader 字体。
   - 支持 TTF / OTF / WOFF / WOFF2 本地字体导入、持久化、选择与删除；仅应用 Reader 正文、译文与摘要，不改变 App UI 字体。
   - 自定义字体文件属于设备本地资源，不写入跨设备配置备份。

7. [x] **文章朗读**
   - 朗读分为 **正文 / 翻译 / AI 摘要** 三部分。
   - Reader 主朗读默认读取正文；翻译启用且当前展示译文时，主朗读自动切换为**仅朗读译文**。
   - AI 摘要窗口内置独立朗读按钮，不把摘要混入主朗读入口。
   - 已接 Chromium Web Speech / 系统可用语音列表，支持开始、暂停、继续、停止、语音选择和文章/模式切换时停止旧朗读。
   - Windows 可使用 Chromium 暴露的 Microsoft / 系统语音；代码没有按界面语言过滤语音。Edge Read Aloud 自己显示的完整 `Online (Natural)` 目录并不等同于 Electron `speechSynthesis.getVoices()` 的枚举结果；当前未接入 Edge Online Natural 完整目录。`ttsVoiceURI` 为设备本地设置，不进入跨设备备份。

8. [x] **AI 摘要阅读布局**
   - 默认继续支持“替换正文”，同时增加左侧栏 / 右侧栏 / 阅读区上方 / 阅读区下方四种停靠模式。
   - 停靠摘要与正文各自保持独立滚动；面板尺寸 220～640 px 可实时调整并持久化。
   - 摘要面板内置位置切换、独立朗读、停止、重新生成和关闭入口。

## 9. 2026-08-15 第二轮实机 UX 回归

- [x] AI / 翻译 Provider 的 API Key 保存、模型加载和连接测试结果改为显示在对应 Provider 卡片内部；Website Rule 测试结果也回到网站规则卡片，避免统一堆在设置页末尾。
- [x] AI 摘要重新建立独立视觉层级：更明显的面板边界、独立 Header / Body / Footer、AI 标识和模式徽标，降低与正文串读的可能。
- [x] 新 AI Prompt 不再生成重复的 `## 摘要` 标题；Renderer 同时清理旧缓存摘要的开头“摘要”标题。
- [x] 摘要面板移除 `zh-CN · STANDARD` 技术元信息；BRIEF / STANDARD / DETAILED 改为用户可读的“速览 / 均衡 / 深入”，Reader 临时选项与全局默认设置均使用三段式选择。
- [x] Reader 翻译目标按“传统翻译 / AI 翻译”分组显示，不再把传统服务和 AI Provider / Model 混成一列。
- [x] 来源页按订阅分组分区显示并展示每组来源数；分组不再只是数据库属性。
- [x] 点击来源卡片进入该来源文章筛选，列表顶部显示当前来源并可退出筛选；点击全局全部 / 未读 / 收藏 / 来源 Tab 会清除来源筛选，避免筛选语义冲突。
- [x] Electron E2E 实际创建来源分组、迁移 Feed、验证分组展示，并确认点击来源后文章列表仅保留该 Feed 的文章。

9. [ ] **GitHub Actions 自动构建**
    - 当前仓库没有可用的 Windows + macOS CI 打包工作流。
    - 需要至少生成 NSIS 与 DMG artifact，并保留后续签名接入点。

10. [ ] **正式签名链**
    - Windows code signing 尚未接入。
    - macOS signing / notarization 尚未接入；证书条件未具备时允许保持发布阻断状态而不伪造完成。

### B. 已实现或已配置，但尚未完成平台验证

1. [ ] **macOS DMG 实际构建验证**
   - `electron-builder.yml` 已配置 `dmg` target，但当前开发基线没有可追溯的 macOS 实际构建结果。

2. [ ] **macOS 启动 / Renderer / WebContentsView / safeStorage 实机验证**
   - Windows 自动化通过不能替代 macOS 平台验证。

3. [ ] **OPML 原生文件选择器人工验收**
   - Core、IPC bridge 和菜单 UI 已有自动测试；仍需实际选择 `.opml/.xml` 文件导入，以及保存 `.opml` 后用其他阅读器/Android OrigRead 打开验证。

4. [ ] **当前最新源码重新生成 Windows NSIS 并安装验证**
   - `release/` 中已有安装包，但在本轮新增 OPML 和此前未提交修复后，必须重新 `package:win` 才能称为当前最新安装包。

5. [ ] **系统语言跟随的最终人工检查**
   - `system / zh / en` 逻辑已实现并有单测；最终发布前需在中文和非中文系统环境各启动一次确认标题、品牌和新增页面文案。

### C. 已实现，但尚缺完整测试 / 验收覆盖

1. [ ] **所有新增收尾功能的中英文覆盖审计**
   - 语言基础设施已完成，但每个后续新增功能仍必须同时补中文 / English 与对应可见性测试。

2. [ ] **发布级全回归矩阵**
   - Windows：typecheck + unit + Electron E2E + NSIS 安装/卸载/重启持久化。
   - macOS：同等主链至少覆盖启动、来源、Reader、WebContentsView、safeStorage、DMG 安装。
   - Android 基线：Desktop 默认不修改 Android；如后续确实修改 Android/shared，则重新执行相应 Android 回归才允许收口。

### D. 工程收口 / 发布卫生

1. [ ] **整理当前 Desktop 未提交工作区**
   - 当前功能开发存在大量已修改/新增但尚未提交的文件；在继续叠加大规模 Reader/发布功能前需要形成清晰基线。
   - 是否 commit / push 由用户决定，助手不得擅自提交或推送。

2. [ ] **确认最终版本号、构建产物命名与 Release 规则**
   - 当前 `package.json` 仍为 `0.1.0` 开发版本；正式 Desktop 1.0 发布前单独确认，不在普通功能开发中擅自改版本号。

## 10. 后续按大项开发顺序

### 大项 A：产品功能闭环

- [x] A1 OPML 导入导出。
- [x] A2 Android ↔ Desktop UI / 产品语义一致性审计并修复明确缺口。
  - 已补 Reader 已读/未读、收藏、下一篇、AI 摘要按次 Provider/模型/长度、翻译目标选择、全文 ↔ Feed 内容双向切换。
  - 已补单来源设置：重命名、URL、分组/新建分组、全文/浏览器互斥、来源级过滤、Website 候选、动态渲染、清空文章、删除来源、重载图标。
  - `isBrowser` 已对齐 Android：点击文章直接标记已读并外部打开，不进入 Reader。
  - `isNotification` 已接真实 Electron Notification，手动和周期同步统一从 `SourceSyncService` 触发，仅通知本轮新增文章。
  - 软件更新归入 B、背景色/深色归入 D；不为完成 A2 提前混做后续大项。
- [x] A3 RSS `BestIconFinder` 行为补齐。
  - 对齐 Android：apple-touch-icon > SVG > PNG > ICO > GIF > JPG，同格式按字节大小；页面失败时回退标准根目录图标。
  - RSS 发现不再以 Feed 自带 image 作为最终图标；来源列表显示持久化图标并在加载失败时回退 RSS 图标。
  - A2/A3 验收：`npm run typecheck` / `npm test`（50 files / 155 tests）/ `npm run build` / Electron E2E（6/6）通过。

### 大项 C：阅读效率增强

- [x] C1 Ctrl + F / Cmd + F 文章内搜索：当前 Reader 内容限定、全部高亮、上一项/下一项和快捷键处理完成。
- [x] C2 Reader 字体切换与本地字体导入：内置字体 + TTF / OTF / WOFF / WOFF2 导入、持久化、删除和 Reader-only 应用完成。
- [x] C3 文章朗读：正文 / 翻译 / AI 摘要三域完成；主入口默认正文、译文正在显示时仅朗读译文；摘要窗口独立朗读按钮；暂停 / 继续 / 停止 / 系统语音选择完成。
- [x] C4 AI 摘要布局：替换正文 / 左 / 右 / 上 / 下和 220～640 px 面板尺寸调整完成，正文与摘要独立滚动。
  - Header 改为按摘要面板自身宽度响应：宽面板保持单行紧凑布局，窄侧栏才自动拆成两行；上下停靠不再被强制撑高。
  - 常驻“面板尺寸”Footer 已移除，尺寸调节改为 Header 内按钮 + 紧凑浮层滑块；上下停靠不再出现突兀的整条控制栏。
  - AI 摘要视觉统一为轻科技蓝：蓝白面板层级、浅蓝渐变 AI 图标、轻阴影和蓝色模式徽标；Android 阅读底栏与 Android AI 摘要面板同步使用同一组科技蓝渐变图标语义。
- 当前回归基线：`npm run typecheck` / `npm test`（53 files / 164 tests）/ `npm run build` / Electron E2E（6/6）通过；Android `:app:compileGithubDebugKotlin` 通过。

### 大项 D：外观系统

- [ ] D1 阅读背景色。
- [ ] D2 全局浅色/深色/跟随系统主题。
- [ ] D3 全页面和 WebContentsView 外层视觉回归。

### 大项 B：发布页与自动更新

- [ ] B1 Desktop Git Release 信息与当前平台安装包选择。
- [ ] B2 手动“检查更新”完整闭环。
- [ ] B3 启动自动检查开关、版本比较、下载/跳转、错误降级。
- [ ] B4 对相关网络与版本选择逻辑增加单测/E2E mock。

### 大项 E：跨平台构建与正式发布

- [ ] E1 GitHub Actions Windows / macOS 自动构建。
- [ ] E2 当前源码 Windows NSIS 重新打包并安装验证。
- [ ] E3 macOS DMG 构建与实机主链验证。
- [ ] E4 Windows 签名、macOS signing/notarization（证书具备后）。
- [ ] E5 最终中英文、安装/卸载、升级、备份恢复、来源/Reader/AI/翻译全回归。

## 6. 每轮开发验收

Desktop 每轮至少执行：

```text
npm run typecheck
npm test
npm run build
```

涉及来源业务时，必须同时用 Android 已验证案例做行为对照；不能因为 TypeScript 实现更方便就改变原有业务顺序。

