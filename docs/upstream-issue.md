# 上游报告底稿 / Upstream report draft

> ## ✅ 实际发布位置 / Actually published at
>
> **deepseek-ai/deepseek-harness 已关闭 Issues，本报告已发布到其 Discussions（General 分类）：**
> **The deepseek-ai/deepseek-harness repository has Issues disabled; this report was published to its Discussions (General category):**
>
> **https://github.com/deepseek-ai/deepseek-harness/discussions/428**
>
> 讨论标题 / Discussion title: **"[Bug] Windows native directory picker truncates paths: UTF-16 chars with low byte 0x00 (e.g. U+5F00) cause workspace-invalid-path ENOENT"**
>
> 下方内容即发布时的完整报告正文（中英双语），本文件保留作为存档与溯源。
> The content below is the full report as published (bilingual); this file is kept as an archive and for provenance.

---

本文件是上述 Discussions 帖的原始底稿（中英双语，可整段复制）。
This is the original draft of the Discussions post linked above (bilingual, copy as-is).

---

## 标题 / Title

**[Windows] 含"低字节为 0x00"字符（如"开" U+5F00）的目录路径被 UTF-16 终止符误判截断，workspace create 失败**
[Windows] Paths containing characters whose UTF-16LE low byte is 0x00 (e.g. "开" U+5F00) are silently truncated by a faulty UTF-16 end-of-string check, breaking workspace creation

## 环境 / Environment

| 项 / Item | 值 / Value |
|---|---|
| OS | Windows 10/11 |
| VS Code | 1.128.0 |
| DSH | @deepseek-ai/dsh 0.1.0-rc.6（web profile / dsh web UI） |

## 复现步骤 / Steps to reproduce

1. 在 Windows 上启动 dsh web（@deepseek-ai/dsh 0.1.0-rc.6），打开 web UI（在 VS Code 1.128.0 侧边栏嵌入或浏览器均可）。
   Start dsh web (@deepseek-ai/dsh 0.1.0-rc.6) on Windows and open the web UI (embedded in VS Code 1.128.0 or in a browser).
2. 使用原生目录选择器切换工作区，选择一个路径中含"开"（U+5F00）的目录，例如 `D:\my_work_project\Dungs_1\慢开`。
   Switch workspace via the native directory picker and pick a directory whose path contains "开" (U+5F00), e.g. `D:\my_work_project\Dungs_1\慢开`.
3. 确认选择并观察结果。
   Confirm the selection and observe the result.

## 实际结果 / Actual result

报错原文 / exact error message:

```text
workspace create failed: workspace-invalid-path: cannot create a workspace at "D:\my_work_project\Dungs_1\慢": ENOENT: no such file or directory, realpath ...
```

所选路径 `D:\my_work_project\Dungs_1\慢开` 被**静默截断**为 `D:\my_work_project\Dungs_1\慢`（丢掉了末尾的"开"），导致工作区创建失败。The selected path `D:\my_work_project\Dungs_1\慢开` is **silently truncated** to `D:\my_work_project\Dungs_1\慢` (the trailing "开" is dropped), so workspace creation fails.

## 预期结果 / Expected result

目录 `D:\my_work_project\Dungs_1\慢开` 应被完整接收并成功创建为工作区。The directory `D:\my_work_project\Dungs_1\慢开` should be accepted intact and created as a workspace successfully.

## 根因分析 / Root cause analysis

`dsh-host-directory-picker-native` 的 `lib/worker.cjs` 中，`readUtf16` 用 `bytes[end] !== 0` 判断 UTF-16 字符串是否结束——只检查了每个 UTF-16 code unit 的**低字节**：

In `lib/worker.cjs` of `dsh-host-directory-picker-native`, `readUtf16` decides the end of the UTF-16 string with `bytes[end] !== 0` — it only inspects the **low byte** of each UTF-16 code unit:

```js
// 现状（有 bug）/ current (buggy) check: 只检查低字节 / low byte only
function readUtf16(bytes) {
  let end = 0;
  while (bytes[end] !== 0) {   // ← U+5F00 的低字节是 0x00，被误判为终止符
    end += 2;                  //    low byte of U+5F00 is 0x00 → mistaken for terminator
  }
  return bytes.toString('utf16le', 0, end);
}
```

"开" = U+5F00，UTF-16LE 编码为两个字节 `[0x00, 0x5F]`：低字节（第一个字节）是 0x00。循环把该 code unit 当成了 NULL 终止符（真正的 NULL 终止符是 `0x00 0x00` 两个字节），于是路径在"开"之前被截断。The character "开" = U+5F00 is encoded in UTF-16LE as `[0x00, 0x5F]`: its low byte (the first byte) is 0x00. The loop mistakes this code unit for the NULL terminator (a real NULL terminator is the two bytes `0x00 0x00`), so the path is truncated right before "开".

**修复建议 / Suggested fix**：改为检查完整的 UTF-16 code unit（两个字节），只有 `0x00 0x00` 才算字符串结束：Check the whole UTF-16 code unit (both bytes); only `0x00 0x00` is the string terminator:

```js
function readUtf16(bytes) {
  let end = 0;
  while (bytes[end] !== 0 || bytes[end + 1] !== 0) {  // 0x00 0x00 才算结束
    end += 2;                                          // terminator = 0x00 0x00
  }
  return bytes.toString('utf16le', 0, end);
}
```

截断后的路径随后传给 `dsh-workspace` 的 `realpathNormalize`（内部 `fs.realpath`）：由于目录并不存在，`fs.realpath` 抛出 `ENOENT`；`dsh-host-apiproxy` 再把它包装成 `workspace create failed: workspace-invalid-path: cannot create a workspace at ...`。The truncated path is then passed to `realpathNormalize` in `dsh-workspace` (which uses `fs.realpath`): the directory does not exist, so `fs.realpath` throws `ENOENT`; `dsh-host-apiproxy` wraps it into `workspace create failed: workspace-invalid-path: cannot create a workspace at ...`.

## 影响面 / Impact

凡路径含"UTF-16 低字节为 0x00"的字符都会中招，即码位形如 **U+XX00** 的字符，例如：

Any path containing a character whose UTF-16LE low byte is 0x00 is affected — i.e. codepoints of the form **U+XX00**, for example:

- U+5F00（"开"，常见汉字 / common Hanzi）—— 本次实测复现 / reproduced here;
- U+0100（"Ā"，Latin Extended-A 块中唯一受影响者 / the only affected codepoint in the U+0100–U+01FF block）;
- U+8F00、U+FF00 等其它 U+XX00 码位 / other U+XX00 codepoints.

注意：判定标准是"**低字节为 0x00**"，而不是"是汉字"。例如同为常见汉字的"快"（U+5FEB，低字节 0xEB）与"持"（U+6301，低字节 0x01）**不受影响**。Note: the criterion is "**low byte is 0x00**", not "is a Hanzi". E.g. the common Hanzi "快" (U+5FEB, low byte 0xEB) and "持" (U+6301, low byte 0x01) are **not** affected.

表现：工作区创建失败，且报错信息中的路径与用户实际所选不一致（被截断），用户难以定位问题。Symptom: workspace creation fails, and the path in the error message differs from what the user actually selected (it is truncated), which is very hard to diagnose.

## 相关组件 / Affected components

- `dsh-host-directory-picker-native/lib/worker.cjs` —— `readUtf16`（根因 / root cause）
- `dsh-workspace` —— `realpathNormalize`（`fs.realpath` 在截断路径上抛 `ENOENT`）
- `dsh-host-apiproxy` —— 把 `ENOENT` 包装成 `workspace create failed: workspace-invalid-path`

## 建议 / Suggestions

- 为 `readUtf16` 增加含非 ASCII 路径的回归测试（至少覆盖 U+0100 与 U+5F00 字符）。
  Add regression tests for `readUtf16` covering non-ASCII paths (at least U+0100 and U+5F00).
