# ByeSky — Bluesky Followings Cleanup

ByeSky is a minimal, secure, and client-side web application designed to help Bluesky / Atmosphere users audit and clean up their followings list. It retrieves your followings, scores each account on custom criteria (such as inactivity, lack of follow-back, or absence of mutual interactions), and allows you to dynamically filter, sort, and batch-unfollow accounts.

👋 ByeSky is fully local-first, ensuring complete data privacy and security.

---

## Key Features

- **100% Client-Side Data Sovereignty**: Authenticates securely using official Bluesky OAuth. No passwords or app passwords are ever collected. All syncing, analysis, and caching occur entirely in your local browser sandbox.
- **Dynamic Weight-Based Scoring**: Real-time client-side scoring calculations. Drag weight sliders (0-5 scale) to immediately adjust what matters to you (e.g. inactive periods, spammy follow-to-follower ratios, social outliers, or deleted accounts).
- **Progressive Background Sync**: High-performance async worker pool fetches profile statistics and scans recent notification/chat logs safely with built-in rate-limit backoff and jitter delays.
- **Refined Data-Explorer Layout**: A highly compact, scannable table dashboard featuring:
  - Tabular monospace numbers and handle subtexts for fast scanning.
  - Custom flat slider trackbars and micro-capsule warning badges.
  - Cohesive keyboard focus indicators (`:focus-visible`) across all clickable elements for high-end accessibility.
- **Accident-Proof Safety Modal**: Single unfollow actions are immediate, but select-all or batch unfollows of more than 10 accounts trigger an explicit confirmation warning modal.

---

## Technical Stack

- **Frontend**: Pure Vanilla HTML5, CSS3, and ES6 JavaScript Modules.
- **Bundler & Dev Server**: Vite 6.0 (for blazing-fast compilation and Hot Module Replacement).
- **Storage**: Browser-native IndexedDB via `UserSyncCache` (`src/cache.js`) with a seamless in-memory fallback for testing.
- **Testing Suite**: Native Node.js test runner (`node:test`, `node:assert`).
- **Code Quality**: Prettier formatter and modern ESLint 9 Flat Config (running static security analysis with `eslint-plugin-security` and quality rules via `eslint-plugin-sonarjs`).

---

## Getting Started

### 1. Prerequisites

Make sure you have [Node.js](https://nodejs.org/) (v18+) and `npm` installed.

### 2. Installation

Clone this repository, navigate to the project directory, and install dependencies:

```bash
npm install
```

### 3. Local Development

Start the local Vite development server:

```bash
npm run dev
```

Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/) in your web browser.

### 4. Running Unit Tests

Run the local unit test suite using Node's native test runner:

```bash
npm run test
```

### 5. Production Compilation

Compile and minify the project assets into optimized distribution files (`dist/`):

```bash
npm run build
```

Preview the compiled production build locally:

```bash
npm run preview
```

---

## Code Quality & Static Analysis

We utilize modern configurations to keep the codebase highly maintainable, formatted, and secure:

- **Unified Project Validation**: Check formatting, run lints, and execute all unit tests in one command:
  ```bash
  npm run check
  ```
- **Code Formatting**: Automatically format all JavaScript, HTML, CSS, JSON, and Markdown files to Prettier standard style rules:
  ```bash
  npm run format
  ```
- **Static Security and Quality Linting**: Run ESLint to verify codebase security principles and code health:
  ```bash
  npm run lint
  ```

---

## License

This project is open-source and licensed under the terms of the [Apache License, Version 2.0](LICENSE).
