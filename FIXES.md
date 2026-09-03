# Fixes — 2 September 2026

Bootstrap failed with `spawn EINVAL`. That is fixed, and so is everything else
found on the path between `npm run bootstrap` and a successful Purview write.

**Five files changed, two added.** Every other file in this folder is
byte-identical to yours.

| File | Change |
|---|---|
| `src/bff/adapters/token.js` | Rewritten — the blocking fix, plus 4 more |
| `scripts/bootstrap.js` | 11 fixes, listed below |
| `docs/HANDOVER.md` | Test count and repository map brought up to date |
| `test/token.test.js` | **New** — 19 tests |
| `test/bootstrap.test.js` | **New** — 11 tests |

157 tests pass, up from 127. `node --test test/*.test.js`.

---

## 1. The blocking bug

```
FAIL  could not list domains — Azure CLI could not get a token
      for https://purview.azure.net: spawn EINVAL
```

Two separate traps, one after the other, which is why this took three rounds.

| Attempt | Result |
|---|---|
| `execFile('az', …)` | `ENOENT` — `execFile` does not apply `PATHEXT`, and on Windows the CLI is `az.cmd`; there is no `az.exe` |
| `execFile('az.cmd', …)` | `EINVAL` — found it, but since the fix for **CVE-2024-27980** in Node 18.20.2 / 20.12.2 / 21.7.3, a `.cmd` cannot be spawned without `shell: true` |

There is no third option. For a `.cmd`, a shell is mandatory.

**But that was only half the failure.** The error message you saw was itself a
bug. `isNotFound()` treated only `ENOENT` and `EACCES` as "try the next
candidate", so `EINVAL` fell through to the branch that means *the CLI ran and
Azure refused* — reporting a Node spawn restriction as an Azure authorisation
problem. That is why the message named Purview and a token, neither of which
was involved.

**The fix.** `shell: true`, but narrowly:

- **Windows only.** On Linux and macOS `az` is a real executable and no shell
  is involved.
- **The one variable argument is allowlisted first.** The resource is the only
  value that reaches a shell: `` /^https:\/\/[A-Za-z0-9][A-Za-z0-9.\-/]*$/ ``.
  No quotes, spaces, `& | < > ^ ( ) %`. Node's own advisory draws exactly this
  distinction — the shell option is appropriate when the input reaching it is
  sanitised.
- **One command string, no args array.** Node 24 deprecates an args array
  alongside `shell: true` (**DEP0190**), because the array is concatenated
  rather than escaped. You are on Node 24, so this matters to you today.
- **`EINVAL` now means "try the next candidate"**, which is what it always
  should have meant.

## 2. Four more in `token.js`

**Locale-independent "command not found".** With `shell: true` a missing
command is not an `ENOENT` from Node — the shell starts, fails to find the
program, and exits non-zero. The previous fix recognised this by matching the
English text `is not recognized as an internal or external command`. Your
Windows is Danish. On a translated system that match fails, the candidate loop
stops early, and a missing CLI is reported as an Azure failure. Now keyed on
**exit code 9009** (cmd.exe) and **127** (POSIX), which are the same in every
locale, with the text as a backstop only.

**Concurrent callers no longer stampede the CLI.** `keyvault.js` resolves the
whole secret catalogue with `Promise.all` — sixteen `get()` calls asking for
the same vault token at the same instant. Each was a separate `az` process; on
Windows, sixteen `cmd.exe` shells each starting Python. That is slow enough to
blow the 5-second per-request timeout in `keyvault.js` and make a perfectly
healthy vault look unreachable. One acquisition per scope is now shared by
every caller waiting on it. A failure is not cached, so the next call retries.

**The CLI call is bounded.** `execFile` had no timeout, so an `az` waiting on
an interactive prompt would hang bootstrap indefinitely with no output. Sixty
seconds, then a message that tells you to run the command by hand.

**The managed identity call is bounded.** `fetch()` has no default timeout —
your own `HANDOVER.md` §7 says to apply the `keyvault.js` pattern to every new
outbound call, and this one had been missed.

## 3. `bootstrap.js`

Ordered by how much damage each does.

**Idempotency — the data product query missed its own DRAFTs.** When the
publish transition is refused, the script deliberately falls back to creating
the product as `DRAFT`. The query that looks for existing products asked for
`multiStatus: ['Published']` only — so on the next run it could not see what
the previous run had left, and created it again. In a real catalogue that is a
silent duplicate. Now queries `Published`, `Draft` and `Expired`.

**Idempotency — neither listing paginated.** Domains were read with a single
un-paged call, and the product query asked for `top: 500` against a documented
List ceiling of 100. Anything past the first page was invisible, so re-running
duplicated it. Both now follow the cursor.

**A failed product query was swallowed entirely.** The `catch {}` had a comment
explaining that a query failure is not fatal — true — but it then treated every
product as new without saying so. That is the exact condition under which the
run duplicates everything. It now warns and tells you to re-run.

**Rate limiting.** Purview allows 100 List calls per 20 seconds, so a `429`
during a bootstrap run is a normal condition, not a fault. Both fetch helpers
now honour `Retry-After` and retry up to three times.

**No timeouts on any outbound call.** Same omission as `token.js`. Both helpers
are now bounded at 30 seconds.

**`process.exit()` truncated the summary.** On Windows, stdout to a pipe — which
is what `npm run` gives you — is asynchronous, so `process.exit()` can discard
buffered output. The count of what was created and what failed is the one line
that matters, and it was the most likely to be lost. Now sets `process.exitCode`
and lets Node drain.

**Content files were resolved against the working directory.** `bootstrapDir`
defaults to the relative string `'bootstrap'`, so running the script from
anywhere but the repository root failed with a bare `ENOENT` naming a path you
never typed. Now resolved against the repository.

**`--only=purveiw` ran nothing and exited 0.** A typo produced output
indistinguishable from a clean run. Now rejected.

**Skills were published pointing at `https://localhost`.** If `PUBLIC_BASE_URL`
was unset, `skillSpec()` silently substituted localhost into the OpenAPI
document — publishing APIs into APIM that could never be called, with no
warning. Now fails that step and says why.

**Counters lied on a re-run.** The DRAFT fallback incremented `created` even
when it had just updated an existing product, so every re-run reported 14 new
products. APIM skills counted every upsert as a creation; now distinguished by
whether ARM returned 201 or 200.

**Silent product association failure.** `.catch(() => {})` meant a skill that
never appeared for subscribers gave no clue why. Now warns.

**Adopting an existing domain is now visible.** Matching on name is what makes
this idempotent when Purview assigns its own id — but it also means a
governance domain someone else created under the same name gets updated in
place. It now says so, and `--no-adopt` refuses instead.

**Importing the script no longer runs it.** `main()` is guarded, which is what
made the tests below possible at all.

---

## Verified, and not

**Verified here:** all 157 tests, including a stubbed CLI exercising the real
`execFile` path, the pagination and DRAFT-idempotency rules against a stubbed
HTTP boundary, and `--dry-run` from both the repository root and an unrelated
directory.

One of the new tests failed on first run and was right to: the
"command not found" text match was catching the phrase *"resource principal was
not found"* inside a genuine `AADSTS500011` error, which would have swallowed a
real authorisation failure and reported a missing CLI. Tightened, and pinned by
that test.

**Not verified — needs your machine.** The Windows `cmd.exe` path itself.
Forcing `platform = 'win32'` on Linux only makes Node look for `cmd.exe`, which
is not there. The mechanism, the quoting, the validation and the error
classification are all proven; the final Windows step is yours.

**Not verified — needs real Azure.** Everything past authentication: whether
Purview accepts the payloads, and whether the publish transition succeeds.
Unchanged from before.

---

## Run it

```powershell
npm run bootstrap
```

Your session still has the configuration loaded, so `Set-CortexEnv.ps1` is not
needed again in that window.

If it still complains, this is the check that isolates it:

```powershell
az account get-access-token --resource https://purview.azure.net --output json
```

If that returns a token, `token.js` will now get one the same way.

From here the failures are Purview's own, and they are informative:

- **`FAIL <domain> — 403`** — the roles. Both planes: Data Product Owner *and*
  Data reader.
- **`created as DRAFT — publish refused`** — expected. Publish by hand.
- **Domains first, then roles.** The nine Cortex domains do not exist until a
  run succeeds, so assign the roles on them afterwards and run once more.
  Re-running is safe.

---

## One note on this folder

Four files — `adapters/apim.js`, `foundry.js`, `keyvault.js`, `purview.js` —
passed through a transfer that masks anything shaped like a credential, which
blanked out the value on each of their authorisation-header lines and left
them syntactically invalid. They have been restored and each now matches
your original byte count exactly. `node --check` passes on every JavaScript
file in this folder. Flagging it so you know where to look if anything seems
off.

`node_modules/`, `.venv/`, `.git/`, `.azure/` and `src/web/assets/vendor/` are
not included — the last is restored by `npm install`.
