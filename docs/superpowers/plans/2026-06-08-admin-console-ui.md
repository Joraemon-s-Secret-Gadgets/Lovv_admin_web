# Admin Console UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the previous Lovv user-facing frontend with a standalone Lovv admin console UI mock that can be deployed as a separate Vercel project.

**Architecture:** The app is a Vite React TypeScript single-page mock. `App` renders `AdminDashboard`, which owns tab state and composes role lanes, metrics, proposal, review, and publish timeline panels from static mock data.

**Tech Stack:** React, TypeScript, Vite, Vitest, Testing Library, ESLint, CSS.

---

### Task 1: Replace Existing Repo Content

**Files:**
- Delete old tracked user-facing Lovv files.
- Create: `.gitignore`, `README.md`, `package.json`, Vite/TypeScript/ESLint config.

- [x] Remove previous tracked content with `git rm -r .`.
- [x] Add Vite React TypeScript project configuration.
- [x] Run `npm install`.

### Task 2: Add Failing Admin UI Tests

**Files:**
- Create: `src/App.test.tsx`
- Create: `src/setupTests.ts`

- [x] Add tests for role lanes, proposal form, review queue, approval actions, and publish timeline.
- [x] Run `npm run test`.
- [x] Confirm the test fails because `src/App.tsx` is not implemented yet.

### Task 3: Implement Admin UI

**Files:**
- Create: `src/App.tsx`
- Create: `src/main.tsx`
- Create: `src/admin/AdminDashboard.tsx`
- Create: `src/admin/adminData.ts`
- Create: `src/admin/types.ts`
- Create: `src/index.css`

- [x] Implement static mock data.
- [x] Implement tabbed admin console UI.
- [x] Implement role, metrics, proposal, review, and publish states.

### Task 4: Verify

**Files:**
- All project files.

- [x] Run `npm run test`.
- [x] Run `npm run lint`.
- [x] Run `npm run build`.
- [x] Start the Vite dev server and verify the app in a browser.

### Task 5: Publish

**Files:**
- All changed files.

- [ ] Commit with `feat: replace app with Lovv admin console`.
- [ ] Push to `origin/main`.
