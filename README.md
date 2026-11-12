# QueryCanvas — Safe AI Text-to-SQL & Analytics Studio

![Vue 3](https://img.shields.io/badge/Frontend-Vue%203%20%2B%20TypeScript-42b883?logo=vuedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Backend-Node.js%20%2B%20Express-000000?logo=express&logoColor=white)
![SQL Guard](https://img.shields.io/badge/Security-AST%20Read--Only%20Firewall-indigo)
![Evals](https://img.shields.io/badge/Evals-8%20Accuracy%20%2B%205%20Security-10b981)

An end-to-end **Full-Stack + AI + Data Analytics** platform built with **Vue 3 + Vite (TypeScript)**, **Apache ECharts**, **CodeMirror 6**, and **Node.js + Express + SQLite / PostgreSQL (`pgvector`) + Redis**.

```mermaid
flowchart LR
  U[Vue 3 + Vite UI] -->|SSE / REST| API[Express TypeScript API]
  API --> RAG[Schema RAG Retrieval]
  API --> CACHE[Redis / Memory Query Cache]
  API --> LLM[Gemini / OpenAI / Ollama / Demo]
  LLM --> GUARD[node-sql-parser AST Firewall]
  GUARD -->|Read-Only SELECT + LIMIT 1000| DB[(SQLite WAL / PostgreSQL pgvector)]
  DB --> INSIGHT[Grounded AI Summary + ECharts]
```

## Features
1. **Natural Language to SQL & Charts**: Converts plain English questions into SQLite/PostgreSQL `SELECT` queries, interactive ECharts (`bar`, `line`, `pie`), and grounded data insights via Server-Sent Events (SSE).
2. **AST SQL Security Firewall (`node-sql-parser`)**: Blocks mutations (`DROP`, `DELETE`, `UPDATE`, `INSERT`, `ALTER`, `PRAGMA`), restricts system tables, enforces `LIMIT 1000`, and executes on a dedicated read-only database handle.
3. **Self-Healing Query Loop**: Automatically catches DB execution errors and repairs broken SQL (up to 2 retries).
4. **Persistent CSV, Excel (`.xlsx`) & PDF Ingestion + Data Profiling**: Upload `.csv`, `.xlsx`, or `.pdf` files to persist queryable tables/documents across uploads, inspect column statistics (nulls, distincts, min/avg/max), and ask AI questions over your uploaded files.
5. **Pin-to-Dashboard BI Board & Multi-Chart PDF Export**: Pin favorite charts to a live multi-chart dashboard that re-runs verified SQL on demand, and export either all charts from your Ask AI session (`Export All (N) PDF`) or your entire pinned dashboard (`Export Full PDF`) into one multi-page PDF report.
6. **1-Click AI Auto-Discover (4 Charts) & Session Chart Switcher**: Click **Auto-Discover (4)** to inspect active schemas or newly uploaded files, automatically generate & run 4 complementary analytical queries, switch between charts in-place, and export all 4 into a single executive PDF.
7. **In-App AI & Security Evaluation Suite**: Run 8 accuracy benchmarks + 5 SQL security firewall checks directly from the **Evals** tab, via `npm run eval`, or `npm test` (a ready-to-use GitHub Actions workflow template is included locally at `.github/workflows/ci.yml`).
8. **Dual Storage Engine**: Works zero-config with built-in SQLite + in-memory cache locally, and scales seamlessly to **PostgreSQL (`pgvector`) + Redis** via `DATABASE_URL` and `REDIS_URL`.

## Local Quick Start

```bash
# 1. Backend
cd backend
npm install
npm run dev

# 2. Frontend (new terminal)
cd frontend
npm install
npm run dev
```
Open `http://localhost:5173`.

### Optional: Production PostgreSQL (`pgvector`) + Redis via Docker
```bash
docker compose up -d
```
Then set `DATABASE_URL=postgresql://querycanvas:querycanvas_dev_password@localhost:5432/querycanvas` and `REDIS_URL=redis://localhost:6379` in `backend/.env`.

## Deployment (Vercel + Render)
- **Backend (Render)**: Uses [render.yaml](render.yaml) (`rootDir: backend`, `npm install && npm run build`, `npm start`).
- **Frontend (Vercel)**: Set Root Directory to `frontend` and update the backend URL in [frontend/vercel.json](frontend/vercel.json).

## Sample Resume Bullets
- *Built **QueryCanvas**, an AI Text-to-SQL & BI platform (Vue 3, Vite, TypeScript, Express, ECharts) with `node-sql-parser` AST validation and read-only DB isolation to prevent SQL injection.*
- *Implemented schema-aware retrieval, self-healing SQL error recovery, Redis query caching, and CSV/Excel ingestion with automated data profiling and an 8-case execution accuracy benchmark.*
