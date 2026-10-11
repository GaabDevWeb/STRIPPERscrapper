# Spike note (core side) — localPath handoff

Data: 2026-08-09  
Owner of full chrome.downloads spike: extension/FE agent (planner ID 9).

## Core contract (decided for bridge v1)

- Core **accepts** `POST /v1/tasks/:taskId/artifact` with JSON `{ localPath, id, type, … }`.
- `localPath` is expected to be an absolute filesystem path produced by the browser download pipeline (e.g. `chrome.downloads` completed filename).
- Core **copies** the file into `downloads/<Section>/…` or `downloads/documents/…`, then runs `validateBinaryFile` + `toMarkdown` (lessons) + manifest updates.
- Core does **not** require Infnet cookies, `session.json`, or CAPTCHA logic on this path.

## Out of scope here

Decision go/no-go for Drive UI + `chrome.downloads` reliability remains with the extension spike owner.
