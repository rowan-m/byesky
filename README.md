# ByeSky — Bluesky Followings Cleanup

ByeSky is a minimal client-side web application designed to help Bluesky / Atmosphere users audit and clean up their following list. It retrieves your followings, scores each account on custom criteria (such as inactivity, lack of follow-back, or absence of mutual interactions), and allows you to dynamically filter, sort, and batch-unfollow accounts.

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
