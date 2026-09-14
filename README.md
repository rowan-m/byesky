# ByeSky — Bluesky Followings Cleanup

ByeSky is a minimal, secure web application designed to help Bluesky / Atmosphere users clean up their followings list. It retrieves your followings, scores each account on custom criteria, and allows you to filter, sort, and batch unfollow accounts.

## Features

- **Progressive Background Syncing**: Safely polls large follow lists, detailed statistics, and interaction histories without triggering API rate limits.
- **Scoring System**: Dynamic, real-time client-side score calculations based on adjustable weighting criteria:
  - **Does Not Follow Back**: Docks points if they are not following you.
  - **Inactive**: Docks points if they haven't posted within a configurable day threshold.
  - **No Interactions**: Docks points if they have never liked, reposted, replied, or messaged you (checked via recent notifications/chat conversations).
  - **Deleted or Banned**: Detects accounts that are suspended, deactivated, or deleted.
  - **Blocking**: Detects if an account is blocking you.
- **Interactive UI**:
  - **Filtering**: Multi-select filters for inactive, non-following, low-follower count, deleted, or blocking accounts.
  - **Sorting**: Toggle headers to sort by Score, Followers Count, Last Post, or Last Like Date.
  - **Batch Operations**: "Select All" on the filtered page to batch unfollow selected accounts.
- **Minimalist Design**: 100% vanilla HTML, CSS, and JS with zero framework bundle overhead, featuring fluid system-font layouts and native dark mode support.

## Technical Stack

- **Backend**: Node.js (v24), Express, `express-session`, and the official `@atproto/api` library.
- **Frontend**: Pure Vanilla HTML5, CSS3, and ES6 JavaScript modules.
- **Testing**: Native Node.js test runner (`node:test`, `node:assert`).

## Getting Started

### 1. Prerequisites

Make sure you have Node.js (v18+) and npm installed.

### 2. Installation

Clone this repository and install dependencies:

```bash
npm install
```

### 3. Setup Environment

Create a `.env` file in the root directory (based on `.env.example`):

```bash
PORT=3000
SESSION_SECRET=some-secure-random-string
```

### 4. Running the Application

Start the Express web server:

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 5. Running Tests

Execute the unit test suite:

```bash
npm test
```
