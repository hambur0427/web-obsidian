# Web Obsidian

Cloud-ready Obsidian-style vault prototype built with Vite, React, TypeScript, and Vercel Functions.

## Features

- Import a local Obsidian vault folder from the browser.
- Import multiple Markdown files.
- Preserve imported folder paths.
- Ignore `.obsidian` configuration folders.
- Display imported notes as an expandable folder tree.
- Edit Markdown with live preview.
- Resize the Markdown preview pane.
- Resolve `[[wiki links]]`.
- Show outgoing links and backlinks.
- Move notes to Trash before permanent deletion.
- Keep trashed notes for 7 days unless they are force deleted.
- Store a local working copy in browser `localStorage`.
- Save and load the current vault from Vercel Blob.
- Provide a Vercel API surface under `/api`.

## Architecture

```text
Browser
  React/Vite app
  Obsidian folder import
  Markdown editor and preview
  localStorage working copy

Vercel
  Static frontend from dist/
  Serverless API from api/
  Private Blob storage for vault JSON

Blob object
  vaults/default.json
```

The app is deployable to Vercel as-is. The browser keeps a local working copy, and `/api/vault` stores the current vault JSON in Vercel Blob. This avoids Supabase or any separate database for the first version.

## Local Development

```bash
npm install
npm run dev
```

Open the URL printed by Vite.

For local testing of Vercel Functions, use Vercel CLI:

```bash
npm i -g vercel
vercel dev
```

## Vercel Deployment

This repo includes `vercel.json`:

- Framework: `vite`
- Build command: `npm run build`
- Output directory: `dist`
- SPA rewrite: non-API routes go to `index.html`
- API routes: files under `api/`

Create Vercel Blob storage:

1. Open the project in Vercel.
2. Go to Storage.
3. Select Create Database.
4. Choose Blob.
5. Set access to Private.
6. Connect it to this project and include the environment variable in Production, Preview, and Development.

Vercel creates `BLOB_READ_WRITE_TOKEN` automatically when the Blob store is connected to the project.

Deploy flow:

```bash
npm run build
vercel
```

Or push the repository to GitHub and import it in Vercel. Vercel should detect the Vite project; the included `vercel.json` keeps the build settings explicit.

## Local Vercel Blob Testing

After creating the Blob store in Vercel, pull environment variables:

```bash
vercel env pull .env.local
vercel dev
```

Use the app:

1. Import an Obsidian folder.
2. Click Save cloud.
3. Refresh or open another browser.
4. Click Load cloud.

## Current API Routes

- `GET /api/health`
- `GET /api/vault`
- `PUT /api/vault`

## Notes

This is a single-vault storage model. It is good for the first personal version. For multiple users, add authentication and either store each user's vault under a separate Blob pathname or introduce a database index later.

## Validation

```bash
npm run lint
npm run build
```
