# Contributing to QueryCanvas

Thank you for contributing to **QueryCanvas**!

## Development Setup

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

## Required Checks Before Opening a PR

1. **Backend typecheck & build:**
   ```bash
   cd backend && npm run build
   ```
2. **SQL AST Firewall unit tests:**
   ```bash
   cd backend && npm test
   ```
3. **8+5 AI Accuracy & Security Evaluation Suite:**
   ```bash
   cd backend && npm run eval
   ```
4. **Frontend TypeScript & Vite build:**
   ```bash
   cd frontend && npm run build
   ```

All pull requests and pushes to `main` automatically run these checks via [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
