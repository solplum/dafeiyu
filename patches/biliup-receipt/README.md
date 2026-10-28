# biliup 1.3.4 单次投稿回执补丁

基于官方固定 commit `95e67857f943f0ea90263668c79191784e94421a`；仅暂存源码有改动。原始官方 arm64 二进制没有替换；随后已在独立构建目录编译受管CLI，安装产物见 `../../staging/biliup-managed-receipt1/manifest.json`。原版官方二进制仍不支持新参数，不能误用。

## 改动

- 单次 `upload` 新增可选 `--receipt-file ABSOLUTE_FILE`，与多任务 `--config` 互斥，默认不指定则保留原行为。
- 在加载凭据和任何网络动作之前，验证 receipt 是全新绝对路径，父目录已存在、为 canonical 私有目录。拒绝现有文件、链接、缺失/开放权限目录及相对路径。仅产生本次私有临时输出，不另建任务 journal。
- 原上传逻辑只执行一次最终提交；仅从最终返回的 ResponseData 提取 code / data.aid / data.bvid。code必须0、aid为正安全整数、bvid为BV+10个ASCII字母数字；不读取日志中的BV串，不写 message、标题、Cookie或access token。
- 在同目录0600临时文件写精确 JSON，fsync文件，用 hard_link 原子发布且绝不覆盖目标，再fsync目录并清理临时文件。目标在处理中被其他调用写入时拒绝覆盖。目录身份/权限变化也拒绝。
- 平台已接受后，字段缺失、写入、无覆盖发布或fsync失败均抛固定 `SUBMISSION_RESULT_UNKNOWN`，不会再次提交。已经发布的receipt即使后续目录fsync报错也保留供核对。

## 防重复归属与接线

复用本项目 `packages/dsh-dafeiyu/src/social/publish-journal.mjs` 的 `PublishJournal`，不建立第二份发布账本。owner runner固定平台`bilibili`、账号mid、任务id，并从私有受管root生成receipt路径；不得让模型或客户端body提供可执行路径、receipt路径或凭据路径。

运行顺序为：`journal.accountLock('bilibili', mid, action)` → 固定任务状态复核 → 原子O_EXCL+fsync写入`journal.claimFile(id)` → `journal.update(id,'dispatching')`持久完成 → 启动已验证的patched二进制。claim仅写一次，与独立receipt路径**不同**。如果已claim、dispatching、submitted或unknown，不能再跑投稿命令。进程未确认停止时保留账号锁；账号/任务所有权来自固定配置及账本，receipt模块不授予新权限。

一次argv示例（仅合同，未运行）：

```text
[patchedBinary, '--user-cookie', fixedOwnerCookiePath, 'upload',
 '--receipt-file', ownerGeneratedFreshReceiptPath,
 '--submit', 'web', '--limit', '1', '--title', approvedTitle,
 '--tid', approvedTid, '--tag', approvedTags, '--desc', approvedDescription,
 approvedAbsoluteVideoPath]
```

spawn必须`shell:false`，原始官方二进制不能用于这一参数。子进程成功也只代表CLI返回；wrapper需读取**本次**receipt、验证精确schema和账号绑定，再按aid/bvid独立回读平台详情并核对owner与元信息。回查失败保持submitted/pending-verification，不自动再投稿。是否审核通过与是否已接收分别报告。丢失receipt、超时、取消、崩溃或回传失败均保留unknown并禁止自动重放。本项目 `src/social/biliup-publisher.mjs` 已包含这层 wrapper，未绑定独立账号，正式发布入口保持关闭。

## 本轮验证与编译边界

- `receipt.rs` 为真实生产模块本体，用 `rustc --edition 2024 --test` 离线编译并执行：8/8通过。覆盖精确JSON及0600、现有文件、途中抢占、无效回执、未完成清理、相对/缺失目录、符号链接、目录权限变化。
- 五个改动源文件 `rustfmt --check --edition 2024 --config skip_children=true` 通过。
- 初轮离线Cargo因缺锁定rust-srec缓存失败；随后按用户明确授权，在独立CARGO_HOME/HOME/target在线下载锁定依赖并完整构建通过（jobs=2）。真实Cargo receipt/CLI参数测试9/9通过，版本与新参数帮助、凭据前拒绝测试通过。Cargo.lock前后SHA-256一致。
- 锁定依赖仅下载至隔离social目录，没有改Cargo.lock、登录/上传/发布、访问真实凭据、改DSH profile或共享journal实现。新增调用层复用原PublishJournal，并完成21项隔离测试。

补丁：`biliup-1.3.4-receipt.patch`；证据：`../../research/biliup-receipt-evidence.json`及相邻日志。可在全新固定版源码目录 `patch --dry-run -p1 < <补丁绝对路径>` 核验，再由具备锁定依赖缓存的构建环境编译。完整二进制及本项目PublishJournal调用层已通过隔离验收；当前仍需owner DSH配置接线和独立真实账号/query驱动，再做指定稿件真实验收。
