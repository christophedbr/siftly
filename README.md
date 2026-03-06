<div align="center">
  <img src="public/logo.svg" alt="Siftly" width="80" height="80" />

  <h1>Siftly</h1>

  <p><strong>Self-hosted Twitter/X bookmark manager with AI-powered organization</strong></p>

  <p>Import · Analyze · Categorize · Search · Explore</p>

  <p>
    <img src="https://img.shields.io/badge/Next.js-15-black?style=flat-square&logo=next.js" alt="Next.js 15" />
    <img src="https://img.shields.io/badge/TypeScript-5-blue?style=flat-square&logo=typescript" alt="TypeScript" />
    <img src="https://img.shields.io/badge/SQLite-local-green?style=flat-square&logo=sqlite" alt="SQLite" />
    <img src="https://img.shields.io/badge/Tailwind-v4-38bdf8?style=flat-square&logo=tailwindcss" alt="Tailwind CSS" />
    <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" alt="MIT License" />
  </p>
</div>

---

## What is Siftly?

Siftly turns your Twitter/X bookmarks into a **searchable, categorized, visual knowledge base** — running entirely on your machine. No cloud, no subscriptions, no browser extensions required. Everything stays local except the AI API calls you control.

It runs a **4-stage AI pipeline** on your bookmarks:

```
📥 Import (built-in bookmarklet or console script — no extensions needed)
    ↓
🏷️  Entity Extraction   — mines hashtags, URLs, mentions from raw tweet data (free, zero API calls)
    ↓
👁️  Vision Analysis      — reads text, objects, and context from every image/GIF/video thumbnail
    ↓
🧠 Semantic Tagging     — generates 30–50 searchable tags per bookmark for AI-powered search
    ↓
📂 Categorization       — assigns each bookmark to 1–3 categories with confidence scores
```

After the pipeline runs, you get:
- **AI search** — find bookmarks by meaning, not just keywords (*"funny meme about crypto crashing"*)
- **Interactive mindmap** — explore your entire bookmark graph visually
- **Filtered browsing** — grid or list view, filter by category, media type, and date
- **Export tools** — download media, export as CSV / JSON / ZIP

**Estimated cost: ~$1.50 to fully process 1,000 bookmarks with 600 images using Claude Haiku.**

---

## Quick Start

> **If you're using Claude Code, Claude CLI, or openclaw:** run these commands one by one. Each step is self-contained.

### Prerequisites

- Node.js 18+
- npm
- An [Anthropic API key](https://console.anthropic.com) *(required for AI features; importing and browsing work without one)*

### 1. Clone & Install

```bash
git clone https://github.com/viperrcrypto/Siftly.git
cd Siftly
npm install
```

### 2. Set Up Database

```bash
npx prisma db push
```

Creates a local SQLite database at `prisma/dev.db`. No external database needed.

### 3. Configure Environment

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
# Required
DATABASE_URL="file:./prisma/dev.db"

# Required for AI features — get yours at console.anthropic.com
ANTHROPIC_API_KEY=sk-ant-...

# Optional: custom API endpoint (for proxies, openclaw routing, or local models)
# ANTHROPIC_BASE_URL=http://localhost:8080
```

> **Tip:** You can also enter your API key directly in the Siftly **Settings** page after launch — no restart required.

### 4. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Importing Your Bookmarks

Siftly has **built-in import tools** — no browser extensions required. Go to the **Import** page and choose either method:

### Method A — Bookmarklet *(Recommended)*

1. Go to **Import** in the Siftly sidebar
2. Drag the **"Export X Bookmarks"** link to your browser's bookmark bar
   *(or copy the URL manually: right-click bookmark bar → Add Bookmark → paste the URL)*
3. Go to [x.com/bookmarks](https://x.com/bookmarks) while logged in to X
4. Click **"Export X Bookmarks"** in your bookmark bar — a purple button appears on the page
5. Click **"▶ Auto-scroll"** — the tool scrolls through and captures all your bookmarks automatically
6. When complete, click the purple **"Export N bookmarks"** button — `bookmarks.json` downloads
7. Back in Siftly → **Import** → drop or upload the file

### Method B — Browser Console Script

1. Go to [x.com/bookmarks](https://x.com/bookmarks) while logged in to X
2. Open DevTools: press `F12` (Windows/Linux) or `⌘⌥J` (Mac), then go to the **Console** tab
3. Copy the console script from the Siftly Import page, paste it into the console, and press Enter
4. Click **"▶ Auto-scroll"** and wait for all bookmarks to be captured
5. Click the export button — `bookmarks.json` downloads automatically
6. Back in Siftly → **Import** → upload the file

### Re-importing

Re-import anytime — Siftly automatically skips duplicates and only adds new bookmarks.

---

## AI Categorization

After importing, Siftly **automatically starts AI categorization**. You can also trigger it manually from:

- The **Import** page (shown immediately after upload)
- The **Mindmap** page (shown when bookmarks are uncategorized)
- The **Categorize** page in the sidebar

### The 4-Stage Pipeline

| Stage | What it does | Cost |
|-------|-------------|------|
| **Entity Extraction** | Mines hashtags, URLs, @mentions, and 80+ known tool/product names from stored tweet JSON | Free |
| **Vision Analysis** | Analyzes every image, GIF, and video thumbnail with Claude's vision model — OCR text, objects, scene, mood, meme templates, 30–40 visual tags | ~$0.001/image |
| **Semantic Tagging** | Generates 30–50 precise search tags per bookmark by combining tweet text + image context | ~$0.0005/bookmark |
| **Categorization** | Assigns 1–3 categories per bookmark with confidence scores using all enriched data | ~$0.0001/bookmark |

The pipeline is **incremental** — if interrupted, it picks up where it left off. Use **"Re-run everything (force all)"** to re-analyze bookmarks that were already processed.

---

## Features

### 🔍 AI Search

Natural language queries across all bookmark data:

- *"funny meme about crypto crashing"*
- *"react hooks tutorial"*
- *"bitcoin price chart"*
- *"best AI coding tools"*

Searches tweet text, image OCR, visual tags, semantic tags, and categories simultaneously. Results are ranked by relevance with AI-generated explanations for each match.

### 🗺️ Mindmap

Interactive force-directed graph showing all bookmarks organized by category:

- Expand/collapse any category to reveal its bookmarks
- Click a bookmark node to open the original tweet on X
- Color-coded legend by category
- Automatically shows an **AI Categorize** prompt when bookmarks haven't been processed yet

### 📚 Browse & Filter

- **Grid view** (masonry layout) or **List view**
- Filter by category, media type (photo / video), or search text
- Sort by newest or oldest
- Pagination with 24 items per page
- Active filter chips — removable individually or all at once
- Hover any card to download media or jump to the original tweet

### ⚙️ Categories

8 default categories pre-seeded with AI-readable descriptions:

| Category | Color |
|----------|-------|
| Funny Memes | Amber |
| AI Resources | Violet |
| Dev Tools | Cyan |
| Design | Pink |
| Finance & Crypto | Green |
| Productivity | Orange |
| News | Indigo |
| General | Slate |

Create custom categories with a name, color, and optional description. The description is passed directly to the AI during categorization — the more specific, the more accurate the results.

### 📤 Export

- **CSV** — spreadsheet-compatible with all fields
- **JSON** — full structured data export
- **ZIP** — exports a category's bookmarks + all media files with a `manifest.csv`

### ⌨️ Command Palette

Press `Cmd+K` (Mac) or `Ctrl+K` (Windows/Linux) to search across all bookmarks from anywhere in the app.

---

## Configuration

All settings are manageable in the **Settings** page at `/settings` or via environment variables:

| Setting | Env Var | Description |
|---------|---------|-------------|
| Anthropic API Key | `ANTHROPIC_API_KEY` | Required for AI features |
| API Base URL | `ANTHROPIC_BASE_URL` | Custom endpoint — proxies, openclaw, local models |
| AI Model | Settings page | Haiku 4.5 (default, cheapest), Sonnet 4.6, Opus 4.6 |
| OpenAI Key | Settings page | Alternative provider if no Anthropic key is set |
| Database | `DATABASE_URL` | SQLite file path |

### Custom API Endpoint

Point Siftly at any Anthropic-compatible server:

```env
ANTHROPIC_BASE_URL=http://localhost:8080
```

Useful for openclaw routing, API proxies, rate-limit management, or self-hosted inference.

---

## Architecture

```
siftly/
├── app/
│   ├── api/
│   │   ├── bookmarks/        # List, filter, paginate, delete
│   │   ├── categorize/       # 4-stage AI pipeline (start, status, stop)
│   │   ├── categories/       # Category CRUD
│   │   ├── export/           # CSV, JSON, ZIP export
│   │   ├── import/           # JSON file import with deduplication
│   │   ├── mindmap/          # Graph nodes + edges for visualization
│   │   ├── search/ai/        # Natural language semantic search
│   │   ├── settings/         # API key + model config
│   │   └── stats/            # Dashboard stats
│   ├── ai-search/            # AI search page
│   ├── bookmarks/            # Browse, filter, paginate
│   ├── categorize/           # Pipeline monitor with live progress
│   ├── categories/           # Category management
│   ├── import/               # 3-step import flow (instructions → upload → categorize)
│   ├── mindmap/              # Interactive graph
│   ├── settings/             # Configuration
│   └── page.tsx              # Dashboard
│
├── components/
│   ├── bookmark-card.tsx     # Card with media, categories, hover actions
│   ├── category-card.tsx     # Category display card
│   ├── command-palette.tsx   # Cmd+K global search
│   ├── nav.tsx               # Sidebar navigation
│   └── theme-toggle.tsx      # Light/dark mode
│
├── lib/
│   ├── categorizer.ts        # AI categorization logic + default categories
│   ├── vision-analyzer.ts    # Image analysis + semantic tagging
│   ├── rawjson-extractor.ts  # Zero-cost entity extraction
│   ├── parser.ts             # Multi-format JSON parser
│   ├── exporter.ts           # CSV, JSON, ZIP export
│   └── db.ts                 # Prisma client singleton
│
└── prisma/
    └── schema.prisma         # SQLite schema
```

### Database Schema

```
Bookmark          — tweet text, author, date, raw JSON, semantic tags, enrichment timestamp
  ├── MediaItem   — images / videos / GIFs with AI-generated image tags
  └── BookmarkCategory — category assignments with confidence scores (0–1)

Category          — name, slug, hex color, AI-readable description
Setting           — key-value store (API keys, model preferences)
ImportJob         — tracks import file status and progress
```

---

## Tech Stack

| Technology | Role |
|------------|------|
| [Next.js 15](https://nextjs.org) | Full-stack framework (App Router) |
| [TypeScript 5](https://www.typescriptlang.org) | Type safety throughout |
| [Prisma 7](https://www.prisma.io) | ORM + migrations |
| [SQLite](https://sqlite.org) | Local database — zero setup |
| [Tailwind CSS v4](https://tailwindcss.com) | Styling |
| [Anthropic SDK](https://anthropic.com) | Vision, semantic tagging, categorization, search |
| [React Flow](https://reactflow.dev) | Interactive mindmap graph |
| [Radix UI](https://www.radix-ui.com) | Accessible UI primitives |
| [JSZip](https://stuk.github.io/jszip/) | Category ZIP export |
| [Lucide React](https://lucide.dev) | Icons |

---

## Development

```bash
# Install dependencies
npm install

# Create database (runs once)
npx prisma db push

# Start development server
npm run dev

# Type check
npx tsc --noEmit

# Open database GUI
npx prisma studio

# Build for production
npm run build && npm start
```

### Customizing Categories

Edit `DEFAULT_CATEGORIES` in `lib/categorizer.ts`. Each entry needs:

```ts
{
  name: 'My Category',       // Display name
  slug: 'my-category',       // URL-safe identifier (must be unique)
  color: '#6366f1',          // Hex color shown in UI
  description: '...',        // Natural language description — used verbatim in AI prompts
}
```

The `description` field directly shapes how the AI classifies bookmarks. Be specific.

### Adding Known Tools

Add domain strings to `KNOWN_TOOL_DOMAINS` in `lib/rawjson-extractor.ts` to have the entity extractor automatically recognize links to those tools in tweet data — no API cost.

---

## Privacy

- All data is stored **locally** in a SQLite file on your machine
- The only external calls are to the AI provider you configure (tweet text + image data)
- No telemetry, no tracking, no accounts required
- Your bookmarks never touch any third-party server except your configured AI endpoint

---

## License

MIT — see [LICENSE](LICENSE)

---

<div align="center">
  <p>Built by <a href="https://x.com/viperr">@viperr</a> · Self-hosted · No extensions · No cloud</p>
</div>
