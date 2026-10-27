# Managed Bilibili read-only MCP fork

Source: [`c1overzz/dsh-bili-scroll` commit `5be5f6d57c47c7e79ad9bc4ce39457b68a160dfa`, `vendor/bilibili-mcp/mcp_server.py`](https://github.com/c1overzz/dsh-bili-scroll/blob/5be5f6d57c47c7e79ad9bc4ce39457b68a160dfa/vendor/bilibili-mcp/mcp_server.py). The embedded MCP is credited upstream to `AGI_Ananas/bilibili-mcp`. Both original MIT license texts are retained as `LICENSE` and `LICENSE.dsh-bili-scroll`.

`PROVENANCE.json` records original and managed SHA-256. `UPSTREAM.patch` contains the complete changes. Original downloaded source, archive, and installed upstream staging package are unchanged.

## Changes

- Lock registration to exactly seven read tools: search, subtitle, comments, video info, cover, frames, and danmaku. Missing/empty environment configuration never enables additional tools; a conflicting list fails closed. Login, comments, messages, reports, and configuration writes are not registered.
- The pinned `bilibili-api-python==17.4.2` implements `Video(..., credential=None)` by creating its native empty `Credential()`. `get_cred()` now uses that same default only when the credential file does not exist. Public APIs decide whether anonymous access is permitted; authentication errors, missing subtitles, and platform restrictions are not bypassed.
- A saved credential that is unreadable, malformed, empty, incomplete, too large, a symlink, or a directory raises an error. It never silently becomes anonymous. Credentials are validated before serving the MCP, including operations such as public search that do not otherwise use a credential.
- No login, permission acquisition, cookie copying, credential refresh, or platform write is added.

## Runtime contract

Use the existing `BiliBrowser` with the pinned Python environment, this script's exact SHA-256, and a fresh private state directory. The host always sends the seven-item allowlist and independently validates the actual `tools/list`. `BiliBrowser` owns process cancellation and cleanup, output bounds, account/session authority checks, and the fixed script copy.

Owner-side runtime values and real read evidence are stored under the task's `social-integration-20261025/research/`. This vendor directory contains no credentials. Future dedicated-account login remains a separate owner action; the MCP does not expose it.

Offline source tests use only the upstream pure registry and credential functions with a fake SDK credential, without importing the network stack. Real MCP initialization and public video information/search/frame reads are verified separately. A passing public read is not account or publication acceptance.

The seven registered read paths do not reach upstream subprocess helpers. `bili_frames` retrieves Bilibili's public storyboard images and crops them with Pillow; it does not launch FFmpeg or download/decode the full video. FFmpeg cover extraction and Whisper installation belong to unregistered helpers. An AST call-graph regression checks this boundary; adding a subprocess read path later requires process-tree cleanup review rather than assuming Python's exit also stops descendants.
