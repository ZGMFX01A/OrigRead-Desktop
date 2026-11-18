# OrigRead Desktop User Guide

[Back to the project](https://github.com/ZGMFX01A/OrigRead-Desktop/blob/main/README.md) · [简体中文](https://github.com/ZGMFX01A/OrigRead-Desktop/blob/main/USER_GUIDE-zh-CN.md)

This guide covers the Windows, macOS, and Linux desktop app. Jump to the task you want to do.

## Quick index

- [Quick start](#quick-start)
- [Add a source](#add-a-source)
- [Manage RSSHub](#manage-rsshub)
- [Read articles](#read-articles)
- [Configure AI](#configure-ai)
- [Use AI summaries](#use-ai-summaries)
- [Use Reader AI Chat](#use-reader-ai-chat)
- [Citation: check an answer's evidence](#citation-check-an-answers-evidence)
- [Search and tools](#search-and-tools)
- [Translate articles](#translate-articles)
- [Share articles as Markdown](#share-articles-as-markdown)
- [Read articles aloud](#read-articles-aloud)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [What to do when a source cannot be added](#what-to-do-when-a-source-cannot-be-added)
- [Use accounts and sync](#use-accounts-and-sync)
- [Manage groups and hierarchy](#manage-groups-and-hierarchy)
- [Rules and filters](#rules-and-filters)
- [OPML, backup and migration](#opml-backup-and-migration)
- [Installation and updates](#installation-and-updates)
- [Troubleshooting](#troubleshooting)
- [Other platforms](#other-platforms)

---

## Quick start

Keep the default **Local** account, add a source you want to read, and open an article to try full text. Configure AI when you want summaries or discussion, and translation when you need another language. Other settings can wait until they become useful.

This guide is also available inside the app under **Settings → About & support → User guide**.

Use the search field in Settings to find an option such as fonts, translation, or web search. Each result shows its category and takes you to the relevant setting. Leaving a page with unsaved changes still asks for confirmation.

---

## Add a source

A subscription does not have to start with an RSS URL. Give OrigRead a website home page, section page, feed, or public API address.

1. Open the **Add subscription** menu on the left and choose to add a source.
2. Paste the URL and start discovery. The window shows its current stage and elapsed time.
3. Check the section, article count, and status of each candidate, then select the content you want.
4. Confirm and return to the timeline for the first sync.

For a particular column, start with its list page. Browse the built-in source directory if you want ideas. To move subscriptions from another reader, export OPML there, then choose **Import OPML** from OrigRead's add menu.

### Choose a parsing result

| Source type | What it can follow | What to check |
| --- | --- | --- |
| RSS / Atom | Standard feeds, including feeds discovered in website pages | Usually a good choice when updates and content match your needs |
| RSSHub | Websites and channels with an existing route | The right section and a working instance |
| Website | Regular article lists on a web page | Correct titles and links, without navigation or ads mixed in |
| JSON / API | Public APIs, WordPress article data, and data in some Next.js / Nuxt pages | Whether the records are the articles you want |
| Dynamic page | Article lists that appear after scripts run | Article count and any confidence notice after rendering |

OrigRead checks titles, links, dates, and article counts before recommending a candidate. A URL may offer several sections or parsing methods. Use the recommendation as a starting point, then choose what you actually want to follow.

Website, JSON/API, and RSSHub sources require a **Local** account. See [accounts and sync](#use-accounts-and-sync) for remote accounts.

---

## Manage RSSHub

An RSSHub route describes how to retrieve a site's articles. An instance is the service that returns them. A matching route still needs an available instance.

Open **Settings → RSSHub**, enable RSSHub, add or enable an accessible instance, and test its connection. You can configure several public or self-hosted instances; the client does not require an RSSHub server running on your computer.

If a route matches but offers nothing subscribable, check for a timeout, invalid content, or a request for a more specific URL. Test or switch instances before retrying. A single failed request does not require deleting route data.

---

## Read articles

| Content | When to use it |
| --- | --- |
| **Source content** | Text supplied by the feed or API, which may be a full article or just an excerpt |
| **Full text** | The extracted article body, suitable for continuous reading, translation, and AI analysis |
| **Original** | The real website inside the app, including comments, charts, and interactive content |

If the source supplies a few lines, try full text first. Open the original if extraction is incomplete. The first full-text fetch can take a moment.

The reader lets you mark articles read, star them, move between articles, and search the text. Adjust the font, size, line height, background, and reading width in appearance settings, or import a local font. In **Settings → General** (under **Reading**), enable **Indent paragraphs** to indent the first line of regular paragraphs by 2em in reader view while preserving layouts for code blocks, quotes, lists, and tables; article titles in the detail pane automatically scale proportionally with body font size for optimal reading comfort.

In **Settings → General**, choose **UI text size** at **100%, 110%, 125%, or 150%** to enlarge text in the source sidebar, article list, settings, and menus. The reader's article font size remains a separate setting. Your choice is saved and included in configuration backups.

Under the **Appearance** section on the same page, **Show article summaries** can be turned off (enabled by default) to hide excerpts and show a compact list with titles, relative publishing dates, and source badges separated by subtle theme-adaptive dividers.

Enable **Show article thumbnails** in the same section to show available article images beside the preview. It is off by default. Articles without a valid image keep the text layout; unavailable images keep a stable placeholder and can be retried by refreshing the source. Within the same source scope, search, read-status filters, and scrolling do not retry failed images. Image requests pause while offline. Image URLs already supplied by the source are used without downloading full articles for the list.

### Difference between "Read" filter and "Recent Reading History"

OrigRead clearly distinguishes between article **Read status** and **Recent Reading History**:

- **Read status**: A persistent flag on each article record. The article list header provides destination tabs in order: **All / Unread / Starred / Read / Recent**. You can toggle read status with the `M` key, mark individual articles read, or batch mark all as read. This status synchronizes bidirectionally with supported remote accounts and drives unread counters. When viewing global read articles under **Read**, the list displays up to the 200 most recently read articles.
- **Recent Reading History**: An independent local record of articles you actually opened and read on this desktop app, ordered by last opened time (accessible from the **Recent** tab in the article list header):
  - Marking an article unread does not remove it from Recent history if you previously opened it.
  - Articles marked read in batch or filtered out without being opened will not appear in Recent history.
  - Re-opening an article moves it to the top of the Recent list.
  - History is kept locally and isolated per account (up to 500 recent items). You can click **Clear reading history** (the trash icon in the list toolbar) at any time; this only wipes the local browsing footprint for the current account without altering any article's read, unread, or starred status.

When the source pane is narrow or UI text is larger, branding contracts to the available space. The tagline and Add label are hidden when needed, while Discover and Add remain accessible as icon buttons with hover labels.

On Windows, window controls share the existing top toolbar. Drag the branding area, article scope title, or an empty part of the reader toolbar to move the window. Native minimize, maximize, and close controls form a group at the top right, distinguished by a subtle background and divider. Use Back to the left of the title to return from Settings or Discover sources to your reading content. Reader actions move into More when toolbar space is limited.

Keep the article and AI side by side. Use the panel's placement control to dock it on the left or right, and drag its edge to resize it. Enter focus reading when you want more room for the article. See [keyboard shortcuts](#keyboard-shortcuts) for common controls.

---

## Configure AI

Connect an OpenAI-compatible service before generating summaries or discussing articles:

1. Open **Settings → AI Settings → Model services** and add a service endpoint.
2. Supply an API key if required, then fetch the model list or enter model names manually.
3. Choose a default model, test the connection, and enable the service.
4. In **Reading**, enable AI reading and check the default service, model, output language, and summary depth.

Use the endpoint, key, and model name supplied by the provider. Add several services if needed, and switch temporarily in summary options or the chat composer.

### Local AI service templates and actual models

At the top of **Settings → AI Settings → Model services**, quick-add preset buttons are available for common local inference engines, such as **Ollama** (`http://localhost:11434/v1`) and **LM Studio** (`http://localhost:1234/v1`):

- **Presets configure endpoints**: Clicking a preset button automatically creates a provider with the standard OpenAI-compatible local endpoint and prefilled name. OrigRead **does not download, package, or execute AI models locally**; you must install and run the local inference tool on your computer.
- **Select or enter models**: Once your local engine is running, click the **Load models** button to query and populate loaded models, or enter a model identifier manually (e.g., `llama3.2`, `qwen2.5`) in the model field. Settings update automatically as you edit.
- **Connection test**: Click **Test connection** to verify connectivity before use. Configured local services can also be chosen in **Translation settings** for article and list translation.

### Where settings live

| Page | What it controls |
| --- | --- |
| **Reading** | AI enabled state, default service and model, output language, summary depth |
| **Model services** | Endpoints, keys, models, and connection tests |
| **Web search** | Search mode, services, and result count |
| **Prompts & behavior** | Custom Instructions, Skills, Quick Messages, remote and local MCP |

Keys are hidden by default. Reveal one when you need to inspect it; saving or leaving settings hides sensitive content again.

---

## Use AI summaries

Open an article, choose **AI Summary**, and use **Quick / Balanced / Deep** as needed. Progress stages and elapsed time appear during generation. Long articles or slower models may take longer; stop the request whenever you no longer need it.

Successful summaries are saved for reuse while the article content is unchanged. To try another model or depth, choose it in summary options and generate again. This temporary choice does not change your defaults.

---

## Use Reader AI Chat

Open an article and expand the AI chat panel. Choose a service and model near the composer, then ask a question such as “What is the author's main evidence?” or “Does this passage agree with the earlier argument?”

To discuss one passage, select it in the article and use **Ask AI**. The selection accompanies the next request only; it is not repeatedly attached to every later message.

### Compare several articles

Click the **paperclip** near the composer and choose recent articles or search by title. Attach up to **5** extra articles; the main article does not count toward that limit. Then ask, for example, “Where do these articles agree, and where do they differ?”

Only selected articles become attachments. An answer's source information shows the material used at the time. Adding or removing attachments later does not rewrite its evidence.

### Continue a discussion

Conversations are saved with their main article. Create, switch, rename, delete, or search them as needed. Stopping generation preserves the content already shown. Regenerating an old answer reuses the original request's article, selection, and attachments.

Reasoning can be displayed when the model supplies it. Article analysis helps examine claims, evidence, and limitations systematically; ordinary chat works well for specific follow-up questions.

---

## Citation: check an answer's evidence

Follow a citation to read the original passage behind an AI conclusion, then judge whether it supports the answer.

1. Click an article reference in the answer.
2. OrigRead locates and highlights the relevant text. If it cites another attached article, that article opens while the discussion remains available.
3. Read the surrounding passage, then continue with the answer or ask another question in the adjacent AI panel.

For example, compare how two reports explain an event's cause. Open each reference to see which original statements account for the difference. With the article and answer side by side, you can check without copying passages or hunting for pages.

### Can I inspect evidence from an old answer?

Saved answers retain their source information. Changing attachments later does not replace it. Citation numbering in the article follows the answer being inspected, so the same number in two different answers may refer to different passages.

If an article changes, is deleted, or cannot be located precisely, inspect the source panel. Web search references open their web sources. Tool references open a source URL when available, or show source information otherwise. A citation makes checking easier; it does not guarantee a correct interpretation.

Citation buttons in the desktop article locate evidence again. After checking, continue reading in the AI panel beside it.

---

## Search and tools

### Look up background or recent developments

Add and test a search service under **Settings → AI reading → Web search**, supplying its required endpoint or key. Keep **AUTO** to search when a question needs recent information, or use **OFF** to disable automatic search. The composer search button can force a search for the next message only, then restores the prior mode.

To use DeepSeek, add **DeepSeek Search** and enter your DeepSeek API key. The default endpoint is `https://api.deepseek.com/v1/tools/search`; no chat model setup is required. Queries accept up to 128 Unicode characters. Your question stays intact; only the automatically added article title is shortened or omitted to fit. Questions that exceed the limit produce an explicit error.

Answers show search activity and results so you can inspect the queries and sources.

### Save recurring ways of asking

**Quick Messages** hold questions such as “List the key evidence.” **Custom Instructions** hold ongoing preferences such as “Explain unfamiliar terms first.” **Skills** hold fuller methods and reference material for summaries, translation, chat, or article analysis.

Manage these under **Prompts & behavior**. Imported Skills supply instructions and resources; OrigRead does not execute their scripts.

### Connect external tools

Configure a remote MCP service or a local MCP service started by a command. Follow the service's instructions for its URL or command, arguments, and authentication, then test the connection and refresh tools.

**Every MCP tool execution requires explicit approval.** Local services start on demand for testing, tool discovery, or execution. Ordinary reading, summaries, and article chat do not need MCP.

See the [AI, Web Search, Skill, and MCP guide](https://github.com/ZGMFX01A/OrigRead-Desktop/blob/main/AI_MCP_SKILLS.md) for detailed configuration.

---

## Translate articles

1. Open **Settings → Translation settings**, enable a service, and supply its endpoint or key if required.
2. Choose the default target language and service, then test the connection.
3. Return to the article and start translation. View translated text or bilingual content as needed.

Options include Microsoft Translator, DeepL, Google Cloud Translation, DeepLX / DLX-compatible services, and a configured OpenAI-compatible model. Conventional translation works without AI setup.

### Service requirements and quota details

- **Microsoft Translator**:
  - Requires creating a Translator resource in Microsoft Azure and entering the generated **API Key**.
  - **Region requirement**: According to official [Microsoft Translator authentication guidance](https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/authentication), multi-service and regional resources require specifying the matching resource region (e.g., `eastasia` or `eastus`), while single-service global resources can leave Region empty.
  - The default endpoint is `https://api.cognitive.microsofttranslator.com`.
- **Google Cloud Translation**:
  - Requires enabling the Cloud Translation API in Google Cloud Console and creating an **API Key**.
  - The default endpoint is `https://translation.googleapis.com/language/translate/v2`.
- **API keys and billing**: Users must provide their own API keys for cloud translation services. Free quotas, trial credits, and usage billing are determined solely by the respective cloud service provider; refer to your provider's management console. OrigRead does not provide unmetered or anonymous web translation proxies.
- **Platform limitation**: Google ML Kit on-device translation is Android-only and has no desktop implementation. Use a cloud translation service or configure a local OpenAI-compatible model on desktop.
- **Local AI translation**: Local OpenAI-compatible services configured in AI settings (e.g., Ollama, LM Studio) can be chosen directly as translation targets in the reader. Full-text and list translations reuse chunking, cancellation, and local persistent caching.

Long articles are processed in sections, so timing depends on length and the service. Compare difficult expressions with the original. DeepL translation tests and quota checks are separate operations; a failed quota check does not necessarily mean translation is unavailable.

---

## Share articles as Markdown

Click **Share** in the reader to copy content to the clipboard, then paste it into your notes.

On first use, choose just the title and link or customize the content to include the article body and any translation or summary currently open. The original URL is always included. Previously generated translations and summaries are omitted when they are not currently open.

Later clicks reuse your choices. **Right-click Share** to change them. Markdown retains headings, quotes, lists, links, and external image URLs. Images are not copied as files, and the receiving app determines how the content is displayed.

---

## Read articles aloud

Articles, translations, and summaries have their own reading actions. When translated text is displayed, the main TTS action reads it preferentially. The summary panel can read the summary separately.

Use the speech controls to start or stop and choose an available voice. The voice list depends on your operating system.

---

## Keyboard shortcuts

Use Ctrl on Windows / Linux and Cmd on macOS.

| Shortcut | Action |
| --- | --- |
| `↑` / `↓` | Scroll the article up / down |
| `←` / `→`, or `K` / `J` | Previous / next article |
| `M` | Toggle read / unread |
| `S` | Toggle starred |
| `U` | Open / close the original page |
| `A` | Toggle the AI assistant |
| `[` | Toggle focus reading |
| `Ctrl/Cmd + F` | Search the article; searches chat first when AI chat is open |
| `Ctrl/Cmd + Shift + F` | Open global article search |
| `Ctrl/Cmd + K` | Focus search in the current list or source switcher |
| `Ctrl/Cmd + Shift + K` | Open the source switcher in the two-pane layout with the workspace visible |
| `,` / `.` | Cycle the open AI panel's placement |
| `-` / `+` | Resize the open AI panel |
| `Esc` | Dismiss the current overlay or search state first; otherwise return from Settings or Discover sources to reading |

Reading shortcuts yield to text entry, dialogs, and settings where the current interface needs those keys.

---

## What to do when a source cannot be added

### Discovery is slow

Check the current stage and let the attempt finish. Public RSSHub instances, page parsing, and dynamic rendering are usually slower than direct feeds. Try a specific section URL if the home page produces the wrong results.

### Dynamic results are unreliable

Dynamic pages must load and run scripts before articles can be found. Some candidates remain available for a manual attempt after a low-confidence notice even without a reliable article list. They are not recommended or selected by default as healthy sources.

**A page loading does not guarantee a reliable subscription.** Check article count, titles, and links before adding, then watch later refreshes. Prefer a stable feed, RSSHub route, or public API where available.

### The browser can open it but OrigRead cannot

Your browser may be signed in, or the site may require a CAPTCHA, paid access, or complex interaction. OrigRead does not bypass those conditions. Look for a feed, working RSSHub route, or public API, and use the original page where necessary.

If you still cannot subscribe, [open an issue](https://github.com/ZGMFX01A/OrigRead-Desktop/issues) with the URL, version, section you want, and error message.

---

## Use accounts and sync

| Account | When to use it |
| --- | --- |
| **Local** | Store data on the computer and use RSS, RSSHub, Website, and JSON/API sources |
| **FreshRSS / Google Reader Compatible** | Connect an existing service to sync subscriptions, groups, articles, and read and starred states |
| **Fever Compatible** | Use the feeds, articles, and reading states the service supplies through Fever |

Add your existing service under **Settings → Accounts** and synchronize. Sync intervals and startup sync belong to the current account and can be set independently.

Subscription management and state synchronization depend on the remote protocol. Fever lacks complete subscription management. Use Local for OrigRead's Website, JSON/API, and RSSHub extensions.

---

## Manage groups and hierarchy

In the source sidebar, groups organize subscriptions with folding, scoped refresh, and context menu actions. Group headers display a folding chevron on the right. Clicking a group name selects its reading scope, while clicking the chevron expands or collapses the group independently.

### Local account group hierarchy

- **Sub-groups and hierarchy**: Local accounts support multi-level group hierarchies. Right-click a group (or open its context menu) and choose **New sub-group** to create a child group under it.
- **Move groups**: Choose **Move group** from the group menu to change its parent group, or select **Root (No parent group)** to move it back to the top level.
- **Group scope**: Selecting a parent group aggregates articles from that group and all of its descendant sub-groups.
- **Rename groups**: Choose **Rename group** to modify a group's name. Renaming preserves the underlying stable group identifier and all subscription memberships.
- **Default group protection**: The default group (such as "Ungrouped") can be renamed while keeping its default role and sources. It cannot be moved or chosen as a parent group for sub-groups. Default group names for remote accounts are stored locally.
- **Blank-area context menu**: Right-click an empty area in the leftmost source sidebar to add a group or source.
- **Literal names without slash splitting**: Group names containing `/` are treated as literal single names and are never automatically split into hierarchy levels.
- **Group-scoped refresh**: Choose **Refresh group** from the group menu to refresh subscriptions within that group and its sub-groups without triggering a full account refresh.

### Remote account groups and limitations

- **Preserve remote flat semantics**: Remote accounts (such as FreshRSS, Google Reader API, and Fever-compatible services) use flat categories or labels. To ensure consistency with remote servers and other clients, remote accounts strictly maintain flat structures.
- **No hierarchy operations**: Creating sub-groups and moving groups are not supported for remote accounts.
- **Rename support and restrictions**:
  - **Google Reader API & FreshRSS**: Renaming a group updates the category on the remote server and syncs the changes.
  - **Fever protocol**: The Fever API does not support category renaming; manage categories through your server's web interface.
- **Remote group refresh**: Selecting **Sync account** from a remote group's menu coordinates with account-level synchronization.

---

## Rules and filters

### When to use a parsing rule

If discovery already finds the content you want, no extra rule is needed. Use a **Website Rule** or **JSON/API Rule** to specify a section or correct parsing results. Website rules find page lists; JSON/API rules read public interfaces or article data embedded in pages.

Manage, import, export, and test rules in their settings pages. Open the in-app rule guide before editing fields manually.

### Ask AI to help create a rule

1. Open **Settings → Website parsing rules** or **JSON rules**, then choose **AI Generate**.
2. Enter an article list page, public JSON endpoint, or page with recognizable article data.
3. Select the AI service and model, then wait for generation and the trial parse.
4. Check counts, scores, sample titles, and links before choosing **Save rule**.

Desktop AI rule generation validates the article list first. Finding articles does not guarantee complete bodies; opening an article can still use normal extraction and the original page. Retest and adjust rules when a website changes.

### Filter unwanted titles

Add keyword or regular-expression rules under **Settings → Article filters**. Keep keywords specific to avoid excluding too much. Rules can be enabled, disabled, imported, and exported.

Filtering affects future articles; **it does not delete saved history**. If results are too broad, disable or edit the rule and check later updates.

---

## OPML, backup and migration

### Choose a migration method

| What you want to do | Use |
| --- | --- |
| Exchange standard subscriptions with another reader | OPML (Local accounts) |
| Move subscriptions, groups, rules, RSSHub, reading preferences, and AI / translation settings | Full configuration backup |
| Sync reading data supported by a remote service across devices | That service's account sync |

Configuration backups can also include search, Skills, Quick Messages, and MCP settings. **They exclude article bodies, read and starred history, and summary and translation caches.**

### Export configuration

Choose **Export full configuration** under **Settings → Backup & restore** and save the file. Credentials are excluded by default. To include saved keys, enable **Include API keys**, set a backup password of at least 6 characters, then export.

### Restore configuration

On the target device, open **Backup & restore**, choose **Restore configuration**, and select the file. For an encrypted backup, first enable **Include API keys** to reveal the password field, enter the original backup password, then choose the file to restore.

Subscriptions with matching URLs are merged; missing ones are added. Other subscriptions and article history remain. Check sources, services, and reading settings after restoration.

### Move between Android and desktop

Compatible configuration backups can transfer subscriptions, rules, and settings supported by both apps. This does not automatically synchronize the whole reading library or make every platform setting identical. Retest services after restoring; local model addresses, font files, and local MCP commands may need reconfiguration on another device.

### Hierarchical group backup and flat downgrade compatibility

- **Desktop hierarchy backup**: Configuration backups use `schemaVersion: 1`. On Desktop, backups for local accounts include optional hierarchy metadata (`desktopGroupHierarchy`) storing parent relationships, allowing full hierarchy restoration on Desktop.
- **Downgrade on older clients**: When importing such backups into OrigRead Android or earlier desktop versions that do not support hierarchy metadata, groups appear as flat groups with escaped full-path names (where `/` becomes `\/` and `\` becomes `\\`). Do not expect older clients to restore or display nested tree hierarchies.
- **Importing legacy backups**: When importing backups without hierarchy metadata into Desktop, groups are imported as flat groups by their exact names; Desktop does not infer or split slashes into a hierarchy.
- **OPML nested groups and remote restriction**: For Local accounts, OPML export and import preserve nested sub-groups and empty groups. Remote accounts do not support importing OPML from the client; manage subscriptions directly on your remote service or switch to a Local account.

---

## Installation and updates

Download the matching file from [GitHub Releases](https://github.com/ZGMFX01A/OrigRead-Desktop/releases/latest).

| System | Installation |
| --- | --- |
| Windows 11 x64 | Run the `.exe` installer and choose an installation location |
| macOS 13+ Apple Silicon | Open the `.dmg` and drag OrigRead into Applications |
| Linux x64 | Use `.AppImage`, or install `.deb` on Ubuntu / Debian |

If an AppImage will not launch, allow it to run as a program in its file properties.

### macOS cannot open the app

Confirm that the app came from the project's official release and is at `/Applications/OrigRead.app`. If macOS reports it as damaged or refuses to open it because of its download quarantine attribute, run this command for that application:

```bash
sudo xattr -r -d com.apple.quarantine /Applications/OrigRead.app
```

This removes that app's download quarantine attribute. The terminal does not show characters while you enter the password. Reopen the app afterward.

### Check for updates

Open **Settings → Software update** to check manually or enable startup checks. The app selects a package for your system; follow its prompts to continue. Android and desktop update independently. A failed update check does not prevent reading.

---

## Troubleshooting

| Problem | What to try first |
| --- | --- |
| AI actions are unavailable | Enable AI reading and check the default service and model |
| Connection testing succeeds but generation fails | Check the model name and supported parameters; a long article may exceed service limits |
| A citation cannot be located | Wait for article loading; inspect source information if content has changed or been deleted |
| Full-text extraction is incomplete | Retry or use the original page for comments, charts, or authenticated content |
| An RSSHub route matches but returns no content | Test or switch the instance and check the specific error |
| The site returns 403 / 418 | Check the address and connection, then retry later; the site may restrict frequency, region, or automated requests |
| Shared Markdown lacks translation or summary | Open that content in the current reader and right-click Share to check your choices |
| An encrypted backup fails to restore | Enter its original password on the backup page before selecting the restore file |

For help or suggestions, [open an issue](https://github.com/ZGMFX01A/OrigRead-Desktop/issues). The project currently does not accept pull requests; use issues for translation and documentation corrections too.

---

## Other platforms

[OrigRead Android](https://github.com/ZGMFX01A/OrigRead) is available for Android phones and tablets.

[Desktop repository](https://github.com/ZGMFX01A/OrigRead-Desktop) · [Download updates](https://github.com/ZGMFX01A/OrigRead-Desktop/releases/latest) · [Report an issue](https://github.com/ZGMFX01A/OrigRead-Desktop/issues)
