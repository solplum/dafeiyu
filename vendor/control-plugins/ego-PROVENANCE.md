# Local managed dsh-ego-browser

Local version: `0.9.2-dfy.1` (valid SemVer prerelease). Original package name,
`license: MIT`, upstream repository metadata and third-party notices are preserved.
This copy is not an upstream release. No downloaded CLI, browser or native payload
was executed while preparing it; tests run plugin JavaScript with fake DSH and
subprocess services. Installation and hands-on validation belong to the parent task.

## Source and integrity

- Repository: https://github.com/Fisfzy/dsh-ego-browser (master, README v0.9.2)
- npm: `dsh-ego-browser@0.9.2`, downloaded with `npm pack --ignore-scripts`.
- Tarball: https://registry.npmjs.org/dsh-ego-browser/-/dsh-ego-browser-0.9.2.tgz
- npm SHA-1: `b8b04f5b2c8ccd7d87e8eb86df761d38df071c4d`
- Tarball SHA-256: `244b2566f6137157740c1880624e589edc9842e67ad4ab20a4ea66b5467d9caf`
- npm integrity: `sha512-X7r2pVoDLcjbDzh4rmsGssoYW0PeAXBKnIAptFF6210RnT7UL0CLDW2pJng5ZCVilmRl1yiTD5OnTS07Y2GggQ==`
- 47 regular files; no symlinks or special entries. No install/postinstall/prepare scripts.
- Node >=22; DSH >=0.1.2-rc.1 and original optional peers preserved.

The unchanged original tarball/extraction and original integrity record remain in
`../../vendor/ego/`. `PATCHES.dfy.diff` is the exact executable/package diff against
that extraction; `MANAGED_SHA256.json` records the frozen executable/package files.
Test/docs/catalog/hash files are local additions and are identified here rather than
included in that executable diff.

## Deliberate local changes

1. Removed whole-script warmup retries and stale-space reset/re-execution.
   Resident failure also returns directly instead of executing one-shot again.
   The legacy exported `runWithStaleSpaceRetry` name stays for compatibility but
   performs exactly one submission. A signal already cancelled submits nothing.
2. Failed or unconfirmed submitted scripts return `EGO_EXECUTION_UNKNOWN`,
   `executionState: unknown`, `retryable: false`; cancellation/timeout metadata is
   preserved. Native actions throw an Error carrying these fields; `ego_script`
   returns them. A host may strip Error properties when serializing; consumers
   must not infer safe retry from their absence. Read back state before deciding.
3. `ego_login_import` is not registered. Its HTTP route always denies authenticated
   callers with `LOGIN_IMPORT_DISABLED`; the internal importer and vendored CLI's
   `--import-chrome-profile` also refuse. `*_FORCE` cannot override this policy.
   Ordinary login in the agent browser and its own cookie persistence remain.
4. All host cast/settings routes use DSH `connection.admit(req)`, require a live
   peer whose `principal.kind === owner`, and fail closed if admission is absent,
   rejected, non-owner, ended or throws. A cookie name alone grants nothing.
   Settings also retain original same-origin + JSON + POST validation.
5. Removed automatic use of a no-sandbox wrapper. Wrapper itself no longer adds
   that flag. Managed plugin and runtime both filter sandbox disabling flags from
   settings/inherited extra Chrome args; the adaptation opt-out cannot bypass
   this guard. A configured Chrome path takes priority over inherited environment.
   macOS defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
   when no explicit nonempty path is configured. Other paths remain configurable.
6. Every cast-worker request now requires a fresh per-process random 32-byte
   token in an internal request header. The token is stored only in the worker
   state file created with mode 0600; host proxies read it server-side for state,
   action, config, snapshots, streams and video. Nothing puts it into frontend
   payloads or logs. Missing/wrong tokens receive 403 before route dispatch;
   OPTIONS returns 204 with no payload or CORS allowance. Legacy tokenless
   workers are not reused by the managed host.
7. Parent-provided `cordis.patch.yml` now seeds the safe Chrome path, empty CLI/
   Chrome flags, CDP capture, isolateSpaces=true, residentExecutor=false and
   idleTimeoutMin=0. Its exact changes are included in PATCHES.dfy.diff.
8. Package and manifest versions changed to `0.9.2-dfy.1`. Tests use Node's test
   runner and VM module stubs, so no dependency install/browser startup is needed.

Read-only snapshot retries that merely reread empty content remain. They do not
replay a click, fill, navigation, upload or arbitrary script.

## Safe initial configuration and persistence

```json
{
  "chromePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "chromeArgs": "",
  "egoCliArgs": "",
  "captureBackend": "cdp",
  "residentExecutor": false,
  "idleTimeoutMin": 0,
  "isolateSpaces": true
}
```

The DSH settings namespace is `ego-browser`. On the current host, the native
plugin settings/volatile loader config feeds the bridge. Owner HTTP:

- `POST /ego/api/get`, body `{}` -> `{ok:true,value:{config,ffmpegStatus}}`.
- `POST /ego/api/set`, body `{patch:{...}}` -> same envelope. This uses
  `settings.update('ego-browser', patch)`; read the settings back after writing.
- Owner-only preview remains `/api/ego/*`. Login import stays denied.

No supported `enableLoginImport` or `disableRetry` key exists or is needed: these
are fixed policy. The original source/README resident fallback and root wrapper
descriptions are obsolete for this copy; the policy above is authoritative.

## Ownership and remaining integration boundaries

- Upstream has one plugin-global current space and FIFO for structured actions;
  optional `space` values are not authenticated against QQ identity/job. The
  Dafeiyu adapter must require a caller-owned explicit space, enforce identity
  and task ownership, and serialize access. Never expose unrestricted raw
  `ego_cli`, `ego_script`, `ego_cdp` or page JavaScript to unrelated users/jobs.
- `isolateSpaces` isolates browser contexts; it is not a principal/QQ ACL.
- Uncertain outcomes never transfer to another executor automatically.
- The vendored runtime uses `~/.local/share/ego-lite-linux` and
  `~/.local/state/ego-lite-linux`, separate from the known native Ego Lite helper.
  Existing helper `/Users/sol/.local/bin/ego-browser` is a Mach-O from Ego Lite
  0.6.0.20. Do not use it as `egoBin`: this plugin launches `node <egoBin>` and
  expects JavaScript. Do not terminate that native app during setup.
- `EGO_LINUX_STATE_DIR` is inconsistently read by upstream plugin/worker versus
  runtime; use consistent XDG_DATA_HOME/XDG_STATE_HOME process isolation if needed.
- Internal cast-worker listeners use random loopback ports protected by the
  managed process token. The separate upstream Spaces overview server retains
  its origin policy; this patch does not claim to replace Chrome CDP or every
  upstream internal transport authentication boundary.
- Explicit FFmpeg install remains owner-only, but initial mode `cdp` needs none.
  Original `apply()` performs FFmpeg discovery; no automatic binary download.

## Contract and verification

`TOOL_CONTRACT.json` is generated from actual managed registrations against fake
DSH services, without executing a tool. Structured actions mostly declare only
`ok:boolean` plus additional properties; adapters must validate actual payloads.

- `ego_snapshot({space,scope?})` -> `{ok:true,text,tries}`; empty reads return
  `{ok:false,text:'',tries,reason}`.
- `ego_read_element({selector,what?,attribute?,space})` ->
  `{ok:true,what,selector,value}`. `what`: text/html/value/attribute/visible/enabled/count.
- `ego_page_info({space})` -> `{ok:true,page:{url,title,w,h,sx,sy,...},humanCheck}`.
- `ego_click`, `ego_fill`, `ego_navigate` return page info, which does not by itself
  prove the requested effect. Read the expected target/nonce afterward.
- `ego_screenshot({selector?,path?,space})` -> `{ok:true,path}`.

Run `node --experimental-vm-modules --test test/managed-policy.test.mjs`.
18 tests passed at the final frozen-source boundary: no duplicate submissions for
connection/space failures, pre/post-start cancellation, timeout, resident loss,
typed action failure, successful output, importer removal, real owner admission,
forged-cookie rejection, owner settings read, sandbox protection, and real
loopback HTTP worker denial/owner-proxy success with one action. This is
isolated logic verification, not hands-on DSH/browser acceptance.
