; Dependency check, as a page of the installation wizard.
;
; Atelier ships its own Node (Electron's) and its own Claude Agent SDK, so
; the only things it needs from the machine are the ones it SHELLS OUT to.
; That list is short and worth being exact about:
;
;   git   REQUIRED. The agent runs `git` directly (execa + simple-git) for
;         status, diff, commit, the merge resolver and the push wizard.
;         Without it those features fail at the moment they are used, with
;         an error that looks like an Atelier bug.
;   node  RECOMMENDED. Nothing in Atelier needs it — this is for the
;         projects you open in it: npm installs, dev servers, test runs.
;   codex / ollama  OPTIONAL providers. Reported, never installed: one is a
;         signed-in CLI account and the other is a multi-GB model runtime,
;         and neither belongs in an install the user is not driving.
;
; Everything happens inside the wizard: one page shows what was found and
; what is missing, with a tickbox per installable tool, and the work itself
; runs on the progress page where its output is printed. No pop-up dialogs
; interrupting the install — the checks ARE a step of it.
;
; Installing is done with winget, which ships with Windows 10 21H2 and
; later. Where it is missing the page still reports, and says what to
; install by hand: a missing package manager must not fail the app's
; install.

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER

Var DepsPage
Var DepsGitCheck
Var DepsNodeCheck
Var DepsGitFound
Var DepsNodeFound
Var DepsCodexFound
Var DepsOllamaFound
Var DepsWingetOk
Var DepsInstallGit
Var DepsInstallNode

; Sets $0 to 1 when <exe> resolves on PATH, 0 when it does not.
!macro DetectTool exe
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /c where ${exe}'
  Pop $0
  Pop $1
  ${If} $0 == 0
    StrCpy $0 1
  ${Else}
    StrCpy $0 0
  ${EndIf}
!macroend

; One line of the report, plus the tickbox when something can be done.
!macro DepsRow y label found note
  ${NSD_CreateLabel} 0 ${y}u 45% 12u "${label}"
  Pop $1
  ${If} ${found} == 1
    ${NSD_CreateLabel} 45% ${y}u 55% 12u "installed"
  ${Else}
    ${NSD_CreateLabel} 45% ${y}u 55% 12u "${note}"
  ${EndIf}
  Pop $1
!macroend

; The page's two functions exist only in the INSTALLER pass.
;
; electron-builder compiles this script twice — once for the installer and
; once for the uninstaller, with BUILD_UNINSTALLER defined — and the
; template's whole page block is itself inside !ifndef BUILD_UNINSTALLER.
; So on the uninstaller pass nothing references these, NSIS emits
; "warning 6010: install function not referenced", and electron-builder
; treats that warning as a build error.
; The wizard page: what is on this machine, and what to do about it.
Function DepsPageShow
  ; No MUI_HEADER_TEXT here: electron-builder's NSIS template is
  ; not built on MUI2, so that macro does not exist. The page says
  ; what it is for in its own first label instead.

  ; Detected here rather than at page create so the numbers are current
  ; even if the user went Back, installed something, and came forward.
  !insertmacro DetectTool "winget"
  StrCpy $DepsWingetOk $0
  !insertmacro DetectTool "git"
  StrCpy $DepsGitFound $0
  !insertmacro DetectTool "node"
  StrCpy $DepsNodeFound $0
  !insertmacro DetectTool "codex"
  StrCpy $DepsCodexFound $0
  !insertmacro DetectTool "ollama"
  StrCpy $DepsOllamaFound $0

  nsDialogs::Create 1018
  Pop $DepsPage
  ${If} $DepsPage == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u \
    "Atelier runs these from your machine. Missing ones can be installed \
now with winget; you can also install them yourself later."
  Pop $1

  !insertmacro DepsRow 26 "Git  (required)" $DepsGitFound "not found"
  !insertmacro DepsRow 40 "Node.js  (for your projects)" $DepsNodeFound "not found"
  !insertmacro DepsRow 54 "Codex CLI  (optional provider)" $DepsCodexFound "not installed"
  !insertmacro DepsRow 68 "Ollama  (optional provider)" $DepsOllamaFound "not installed"

  ${If} $DepsWingetOk == 1
    ${If} $DepsGitFound == 0
      ${NSD_CreateCheckbox} 0 88u 100% 12u "Install Git with winget"
      Pop $DepsGitCheck
      ${NSD_Check} $DepsGitCheck
    ${EndIf}
    ${If} $DepsNodeFound == 0
      ${NSD_CreateCheckbox} 0 102u 100% 12u "Install Node.js LTS with winget"
      Pop $DepsNodeCheck
      ${NSD_Check} $DepsNodeCheck
    ${EndIf}
    ${If} $DepsGitFound == 1
    ${AndIf} $DepsNodeFound == 1
      ${NSD_CreateLabel} 0 88u 100% 24u \
        "Everything Atelier needs is already here. Continue to install."
      Pop $1
    ${EndIf}
  ${Else}
    ${NSD_CreateLabel} 0 88u 100% 24u \
      "winget was not found, so nothing can be installed automatically. \
Install any missing tool from git-scm.com or nodejs.org, then reopen Atelier."
    Pop $1
  ${EndIf}

  nsDialogs::Show
FunctionEnd

; Reads the tickboxes before the page is destroyed; the install section
; runs long after this and cannot query dead controls.
Function DepsPageLeave
  StrCpy $DepsInstallGit 0
  StrCpy $DepsInstallNode 0
  ${If} $DepsGitCheck != 0
    ${NSD_GetState} $DepsGitCheck $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $DepsInstallGit 1
    ${EndIf}
  ${EndIf}
  ${If} $DepsNodeCheck != 0
    ${NSD_GetState} $DepsNodeCheck $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $DepsInstallNode 1
    ${EndIf}
  ${EndIf}
FunctionEnd

!endif

; label / wingetId / whether the page asked for it
!macro InstallTool label wingetId wanted
  ${If} ${wanted} == 1
    DetailPrint "Installing ${label} with winget (${wingetId})..."
    nsExec::ExecToLog 'winget install --id ${wingetId} -e --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity'
    Pop $0
    ${If} $0 == 0
      ; This process's PATH is a snapshot from before the install, so
      ; re-checking here would report MISSING for something now present.
      ; Say what happened instead of guessing.
      DetailPrint "  ${label}: installed (sign out and back in if it is not on PATH yet)"
    ${Else}
      DetailPrint "  ${label}: winget exited $0 - install it manually"
    ${EndIf}
  ${EndIf}
!macroend

!macro customHeader
  ; The dependency work is printed on the progress page, so the log is
  ; open from the start rather than hidden behind "Show details".
  ShowInstDetails show
!macroend

!macro customPageAfterChangeDir
  Page custom DepsPageShow DepsPageLeave
!macroend

!macro customInstall
  ; electron-builder's install section opens with `SetDetailsPrint none`
  ; (templates/nsis/installSection.nsh), which discards every DetailPrint
  ; that follows — including all of ours. That is why the log box rendered
  ; empty while the tool checks were running perfectly well. Turn printing
  ; back on for our part, and hand it back afterwards so the file-copy stage
  ; stays as quiet as electron-builder intends.
  SetDetailsPrint both

  DetailPrint "----------------------------------------"
  DetailPrint "Required tools"
  ${If} $DepsGitFound == 1
    DetailPrint "  Git ....... found"
  ${Else}
    DetailPrint "  Git ....... MISSING"
  ${EndIf}
  ${If} $DepsNodeFound == 1
    DetailPrint "  Node.js ... found"
  ${Else}
    DetailPrint "  Node.js ... MISSING"
  ${EndIf}
  ${If} $DepsCodexFound == 1
    DetailPrint "  Codex CLI . found (optional)"
  ${Else}
    DetailPrint "  Codex CLI . not installed (optional)"
  ${EndIf}
  ${If} $DepsOllamaFound == 1
    DetailPrint "  Ollama .... found (optional)"
  ${Else}
    DetailPrint "  Ollama .... not installed (optional)"
  ${EndIf}

  !insertmacro InstallTool "Git" "Git.Git" $DepsInstallGit
  !insertmacro InstallTool "Node.js" "OpenJS.NodeJS.LTS" $DepsInstallNode

  ${If} $DepsInstallGit == 0
  ${AndIf} $DepsInstallNode == 0
    DetailPrint "  nothing to install"
  ${EndIf}
  DetailPrint "----------------------------------------"
  DetailPrint "Installing Atelier..."

  SetDetailsPrint none
!macroend
