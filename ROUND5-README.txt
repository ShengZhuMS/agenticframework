Cortex — round 5 (11 September 2026): back to live
====================================================

WHAT IS IN THIS ZIP
  13 files, at their repository paths. Two are new; the rest replace files in
  your agenticframework folder. Nothing else in the repository changes.

    .vscode/tasks.json                      + 4 tasks (Diagnose, Repair storage, Report only, Demo identities)
    CHANGES.md                              Addendum 8 at the top — the full change list
    README.md                               test count, new script, demo command
    docs/DEPLOY.md                          rewritten as an ordered runbook
    infra/main.bicep                        mountState parameter (MOUNT_STATE)
    infra/main.parameters.json              MOUNT_STATE wired through
    scripts/Deploy-Cortex.ps1               step 7b storage/policy check, revision health gate, honest verdict, -DemoIdentities
    scripts/Set-CortexStorageAccess.ps1     NEW — the storage lockdown repair (exemption + settings + verify)
    scripts/Test-Cortex.ps1                 revision + storage checks, -Diagnose
    scripts/bootstrap-data.js               stop on the first network refusal; verify the indexers
    scripts/bootstrap.js                    skip search when data could not be written
    src/bff/adapters/storage.js             tell the two 403s apart
    test/storage-access.test.js             NEW — 12 tests

  round5.patch (next to this zip) is the same change as a unified diff, for
  reading in a diff viewer before you apply anything.

HOW TO APPLY
  1. Close VS Code's terminals that have the old scripts loaded.
  2. Extract the zip OVER your repository folder
       C:\Users\shengzhu\OneDrive - Microsoft\Documents\14. Agentic Framework\agenticframework
     letting it replace the 11 existing files. (git diff shows exactly what changed.)
  3. The new files arrive with the Mark of the Web. Deploy-Cortex.ps1 unblocks
     every script at step 1, so nothing to do — but if PowerShell refuses to
     start it:   Get-ChildItem -Recurse -Include *.ps1 | Unblock-File
  4. Prove the code first, no Azure needed:
       npm test                       -> 305 tests pass
  5. Then the deployment:
       .\scripts\Deploy-Cortex.ps1
     Watch step 7b (the storage accounts) and step 8 (the revisions). The run
     ends with "every check passed" in green, or the list of what did not in
     red — no more green banner over a broken app.
  6. When it is green:
       .\scripts\Test-Cortex.ps1
     and open the web URL. If anything is red:
       .\scripts\Test-Cortex.ps1 -Diagnose
     and paste everything between the two marker lines back to me.

THE DEMO SET-UP (optional, any time after step 5)
       .\scripts\Deploy-Cortex.ps1 -SkipProvision -SkipBootstrap -SkipHealthCheck -DemoIdentities -DemoUserEmail <address>
     Creates and maps the five demo groups, puts you in all of them, and puts
     the second account in "Cortex Analysts" only. docs/DEPLOY.md §5 says what
     each account then sees.

IF THE POLICY CANNOT BE EXEMPTED
     Step 7b prints the exact `az policy exemption create` command for an
     Owner. Until it runs, the settings are repaired on every deployment; or
       .\scripts\Deploy-Cortex.ps1 -NoStateShare
     keeps everything but persistence.

WHAT WAS NOT VERIFIED HERE
     Everything against your tenant — see CHANGES.md, Addendum 8, "Verified,
     and not". The three things most likely to need a nudge are listed there
     in order.
