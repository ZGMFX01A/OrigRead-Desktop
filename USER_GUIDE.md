# OrigRead Desktop User Guide

<div align="center">
  <a href="USER_GUIDE.md">English</a> |
  <a href="USER_GUIDE-zh-CN.md">简体中文</a>
</div>
## Quick index

- [Quick start](#quick-start)
- [Add a source](#add-a-source)
- [Read articles](#read-articles)
- [Use AI summaries](#use-ai-summaries)
- [Translate articles](#translate-articles)
- [Read articles aloud](#read-articles-aloud)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [What to do when a source cannot be added](#what-to-do-when-a-source-cannot-be-added)
- [Manage RSSHub](#manage-rsshub)
- [Use accounts and sync](#use-accounts-and-sync)
- [Rules and filters](#rules-and-filters)
- [OPML, backup and migration](#opml-backup-and-migration)
- [Troubleshooting](#troubleshooting)

---

## Quick start

For the basic reading workflow:

1. Open OrigRead Desktop and keep the default **Local** account.
2. Select **+ Add** and paste an RSS/feed or website URL.
3. Wait for source detection to finish, choose the recommended candidate and add it.
4. Return to the article list and open an article.
5. If the source only provides a short summary, switch to full text; open the original page when you need the real website.
6. Configure AI or translation later, only if you want those features.

You do not need to configure FreshRSS, a self-hosted RSSHub instance, Website Rules or AI before you can start reading ordinary feeds and websites.

---

## Add a source

### Add a website, RSS feed or Atom feed

1. Select **+ Add** in the left workspace area.
2. Paste a website homepage, article-list page, RSS/Atom feed or another source URL.
3. Start detection. OrigRead shows the current stage and elapsed time while it analyzes the URL.
4. Review the candidates. A suitable option is recommended by default, but you can choose another usable candidate.
5. Confirm the source and return to the timeline for the first sync.

### How to choose between candidates

| Candidate | When it is useful | Typical choice |
| --- | --- | --- |
| **RSS / Atom** | The site already provides a standard feed | Usually preferred because it is stable and fast to refresh |
| **RSSHub** | RSSHub has a route for the site | Convenient when the route works; a site may expose several channels |
| **JSON/API** | The site has a stable public endpoint | Often less affected by visual redesigns |
| **Website** | There is no feed, but the webpage has a stable article list | Useful, though a redesign may require a different rule |
| **Dynamic website** | The article list appears only after JavaScript runs | A final fallback and usually slower |

When several candidates work, prioritize **reliable refreshes and correct titles/links** instead of the most technically complex method.

### Import from OPML

1. Export an `.opml` or `.xml` file from your current feed reader.
2. In OrigRead Desktop, open the add menu and choose **Import OPML**.
3. Select the file and confirm the import.
4. Review the imported groups and source count.

OPML is for standard feed migration. Use configuration backup for OrigRead-specific rules, RSSHub settings, AI/translation configuration and other application settings.

---

## Read articles

### Source content, full text and original page

- **Source content** — content supplied directly by RSS/Atom/JSON. Some feeds provide only a summary.
- **Full text** — article text extracted after OrigRead fetches the webpage; suitable for reading, search, translation and AI summary.
- **Original page** — the real website opened inside the app.

If an article only contains a few lines, switch to full text first. If extraction is still incomplete, open the original page.

### Mark and navigate articles

From the reader you can:

- mark read/unread;
- star/unstar;
- move to the previous or next article;
- search within the current article;
- open the original page.

### Adjust reading appearance

Settings include:

- reader font;
- local font import;
- font size;
- reader background color;
- light, dark or system theme.

These settings change presentation only; they do not modify article content.

---

## Use AI summaries

### Configure an AI provider first

1. Open **Settings → AI Reading**.
2. Add an OpenAI-compatible provider.
3. Enter its endpoint and API key when required.
4. Fetch or enter models and choose a default model.
5. Select **Test connection**.
6. Save and enable the provider after the test succeeds.

You can configure several providers, each with its own endpoint, key and model list.

### Generate a summary

1. Open an article.
2. Choose **AI Summary**.
3. OrigRead starts with the current default provider, model and summary mode.
4. The UI shows real stages such as preparing the article, waiting for AI, and saving the result, together with elapsed time.
5. Cancel the request if you no longer need it.

### Temporarily change provider, model or summary mode

Summary options let you choose, for this generation only:

- provider;
- model;
- brief, standard or detailed mode.

Temporary choices do not overwrite your global defaults.

### Move the summary panel

The AI summary can:

- replace the article body;
- dock left;
- dock right;
- dock above;
- dock below.

Docked panels can be resized, and keyboard shortcuts are available for position and size changes.

> **AI-generated JSON rules and AI-generated Website Rules are not finished.** Their entries remain disabled and do not affect normal AI summaries or AI full-article translation.

---

## Translate articles

### Configure translation providers

1. Open **Settings → Translation**.
2. Enable the translation methods you want.
3. Configure the endpoint, key or other required parameters for each service.
4. Choose a default target language and provider.
5. Use the connection test to verify the service.

Desktop supports Microsoft Translator, DeepL, Google Cloud Translation and DeepLX/DLX, and can also use OpenAI-compatible models for full-article translation.

### Translate the current article

1. Open an article.
2. Select the translation control.
3. OrigRead uses the current default provider and target language.
4. After translation, view translated content or the available original/bilingual presentation.

Traditional translation does not depend on AI summaries. DeepL or Microsoft translation works even if no summary model is configured.

---

## Read articles aloud

OrigRead Desktop keeps reading domains separate:

- article text;
- translated text;
- AI summary.

When translated text is the primary reading content, the main read-aloud control follows the translation. The AI summary panel has its own read-aloud action.

Available voices depend on the operating system and the speech voices visible to Electron.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `↑` / `↓` | Scroll article up / down |
| `←` / `→` | Previous / next article |
| `K` / `J` | Previous / next article (compatibility shortcuts) |
| `M` | Toggle read/unread |
| `S` | Toggle starred |
| `U` | Open / close original page |
| `[` | Collapse / expand workspace |
| `Ctrl/Cmd + F` | Search the current article |
| `,` / `.` | Cycle AI summary position |
| `-` / `+` | Shrink / enlarge a docked AI summary panel |

When focus is inside an input, dialog or settings control, reading shortcuts yield to normal text/control input.

---

## What to do when a source cannot be added

### Check the current detection stage

The add-source window shows whether OrigRead is checking RSS, RSSHub, JSON/API, static Website parsing or a dynamic page.

If a stage is slow, allow it to finish. Public RSSHub instances and dynamic pages can naturally take longer than direct RSS.

### What “dynamic Chromium fallback” means

Some websites do not include the article list in the initial HTML; JavaScript creates it later. When ordinary parsing cannot see those articles, Desktop can automatically start a restricted Chromium page as the final fallback.

You do not need to enable this manually.

If the rendered page produces real articles but looks less reliable, the candidate may include a warning. In that case:

1. Check whether titles and article count look sensible.
2. Add it if the result looks valid.
3. Watch later refreshes to see whether it remains stable.
4. If it repeatedly fails, prefer RSS, RSSHub, a public API or an explicit rule.

**A page merely rendering is not enough.** If no usable article links are extracted, OrigRead does not create an empty source.

### The site opens in a browser but cannot be subscribed

Common reasons include:

- login is required;
- CAPTCHA or browser challenges;
- the list appears only after complex interaction;
- there is no stable article-list structure;
- automated requests are restricted;
- the current network cannot reach RSSHub/API services.

OrigRead does not bypass login walls, CAPTCHA, paywalls or website access controls. Prefer an official feed, RSSHub route or public API when available.

---

## Manage RSSHub

Open **Settings → RSSHub** to:

1. enable or disable RSSHub;
2. enable or disable individual instances;
3. add public or self-hosted instances;
4. test an instance;
5. restore default instance settings.

### Why a route can be “matched” but not subscribable

OrigRead matches routes locally before contacting an instance. Therefore:

**Matched route ≠ the current RSSHub instance is available.**

Typical states:

- **Available** — the instance generated a usable feed;
- **Timed out / unreachable** — the route exists but the request failed;
- **No valid feed** — the instance responded, but not with a usable feed;
- **Content failed quality checks** — content was returned but is not suitable for the timeline;
- **More specific URL required** — the route needs parameters missing from the current URL.

Public instances can be unstable. Retry later or switch instances when needed.

---

## Use accounts and sync

### Local

Local is sufficient for most users and supports all OrigRead source types:

- RSS / Atom;
- RSSHub;
- Website;
- JSON/API.

### FreshRSS / Google Reader Compatible

If you run a compatible server, add a remote account to sync subscriptions, groups, articles, read state and starred state.

When the remote protocol supports subscription maintenance, adding, moving or renaming RSS sources is performed against the server rather than silently creating local-only data.

### Fever Compatible

Fever accounts sync the feeds, articles, unread state and saved/starred state exposed by the Fever protocol. If the protocol does not provide complete subscription maintenance, OrigRead does not pretend that remote add/move/rename operations exist.

### Sync settings

Sync interval and startup-sync preferences belong to the current account. Different accounts can keep different sync settings.

If you do not need server-based cross-device sync, staying on Local is enough.

---

## Rules and filters

### Website Rules

Use these when a website has no usable feed but exposes a relatively stable HTML article list.

### JSON/API Rules

Use these when a site exposes a stable REST/JSON or another structured endpoint. A stable API is usually less fragile than page CSS selectors.

### Article filters

Use filters when you want to keep a source but exclude certain titles from the normal timeline. Keywords and regular expressions are supported.

A new filter affects newly fetched articles and does not retroactively delete historical articles.

Ordinary users do not need to learn rule syntax before adding common websites. Try automatic source discovery first and use explicit rules only when needed.

---

## OPML, backup and migration

### When to use OPML

Use OPML to exchange standard feed subscriptions with other RSS readers.

### When to use configuration backup

Use OrigRead configuration backup when moving richer settings between OrigRead Android and Desktop. It can include:

- subscriptions and groups for the current account;
- Website/JSON rules;
- article filters;
- RSSHub configuration;
- reading preferences;
- translation and AI configuration.

Article bodies, read/star history, AI summary caches and translation caches are not part of configuration backup.

Sensitive credentials are excluded by default. They are exported only when you explicitly include them and protect the backup with a password.

---

## Software updates

Open **Settings → Software Update** to check manually, or enable automatic checks at startup.

When a release is available, OrigRead selects the installer for the current operating system. A failed GitHub/network check does not interrupt normal reading.

---

## Troubleshooting

### Source detection stays on RSSHub for a long time

Public RSSHub instances can be slow or temporarily unavailable. Let the current detection finish; if it happens frequently, disable unstable instances or use your own instance under **Settings → RSSHub**.

### RSSHub is matched but there is no subscribable result

The local route match succeeded, but the instance request or returned feed failed. Read the specific status instead of repeatedly removing and re-adding the same URL.

### AI connection test succeeds but generation fails

A successful connection test proves that the endpoint/key is basically reachable. Check whether the selected model actually supports the request parameters and whether the model name is correct.

### What is the difference between DeepL test and usage query?

The connection test verifies translation. Usage/limit lookup is a separate action. A failed usage endpoint does not automatically mean translation itself is unavailable.

### Original webpage and reader content look different

Reader content is extracted and cleaned for reading; Original is the real webpage. For complex tables, comments, interactive widgets or login-gated content, use the original page as the source of truth.

### Dynamic sources refresh slowly

Dynamic sources need to start Chromium, wait for page scripts and parse the rendered result. Standard RSS, RSSHub or stable APIs are usually faster and more reliable when available.

---

## Other platforms

📱 **OrigRead Android**: https://github.com/ZGMFX01A/OrigRead
