# Beat

A screenplay editor for importing rough drafts, applying screenplay formatting, and reviewing changes with collaborators.

## Features

- Editable screenplay elements with formatting suggestions and passage-level copy and paste.
- Measured editor pagination and Fountain, plain-text, and PDF exports.
- A shared project library with separate documents and drafts.
- Named writing sessions, review before making changes current, and version history.
- A local SQLite adapter for trying the collaboration workflow without API keys or cloud services.

## Run locally

Use Node.js 22.13 or newer.

```sh
npm ci
npm run dev
```

Open the loopback address printed by the server. The default port is 53793. Data is held in memory and disappears when the server stops. To keep your own local drafts:

```sh
npm run dev -- --db ./local.sqlite
```

SQLite files are ignored by Git. The shared project library is visible to everyone using the same running instance. Writer names are self-entered. The comments panel is a UI demonstration and does not synchronize comments.

```sh
npm test
npm run build
```

The production build writes static client files to `dist/client`. `npm run preview` previews that client only; use `npm run dev` for the local room and project APIs. Cloud deployment configuration is not included.

## Project context

This project began with a personal need to make draft formatting and collaborative revisions easier. The product work included defining workflows, testing the editor on practical writing tasks, identifying failures, and directing iterative improvements. The implementation was developed with Codex assistance. The application remains a prototype.

This is a standalone source snapshot. The example screenplay and all test writers, rooms, and keys are fictional fixtures. It includes no live documents, collaborator portraits, saved browser state, or service credentials. No environment variables or API keys are needed for local use.

## Licensing

No project-wide license has been added to this snapshot. Third-party dependencies retain their own licenses, as recorded in the lockfile and installed packages. No third-party dependency source is vendored here.
