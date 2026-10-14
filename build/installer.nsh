!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define JUDGE_MODEL_SPACE_KB 1048576
!define DEBATE_MODEL_3B_SPACE_KB 2097152
!define DEBATE_MODEL_7B_SPACE_KB 4718592
!define DEBATE_MODEL_14B_SPACE_KB 9437184

!ifndef BUILD_UNINSTALLER
Var DebateModel3BInput
Var DebateModel7BInput
Var DebateModel14BInput
Var InstallerDialogueModel

!macro customInit
  SectionGetSize 0 $0
  IntOp $0 $0 + ${DEBATE_MODEL_3B_SPACE_KB}
  IntOp $0 $0 + ${JUDGE_MODEL_SPACE_KB}
  SectionSetSize 0 $0
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_HEADER_TEXT "Local AI models"
  !define MUI_PAGE_HEADER_SUBTEXT "Choose a dialogue model. The 1.5B judge model is also installed."
  Page custom DebateModelSettingsPage DebateModelSettingsLeave
  !undef MUI_PAGE_HEADER_TEXT
  !undef MUI_PAGE_HEADER_SUBTEXT
!macroend

!macro customInstall
  SetDetailsView show
  DetailPrint "Installing Ollama, downloading $InstallerDialogueModel, and downloading qwen2.5:1.5b..."
  System::Call 'Kernel32::SetEnvironmentVariable(t, t) i ("DEBATE_INSTALL_DIALOGUE_MODEL", "$InstallerDialogueModel").r0'
  nsExec::ExecToLog /TIMEOUT=2700000 '"$appExe" --installer-setup'
  Pop $0
  DetailPrint "AI setup process result: $0"
  System::Call 'Kernel32::SetEnvironmentVariable(t, t) i ("DEBATE_INSTALL_DIALOGUE_MODEL", "").r1'
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Ollama/model setup failed. Review the installer details for more information."
    Abort
  ${EndIf}
  WriteRegStr HKCU "Software\DebateStudio" "DialogueModel" "$InstallerDialogueModel"
  CreateShortCut "$DESKTOP\Debate Studio.lnk" "$INSTDIR\Debate Studio.exe" "" "$INSTDIR\resources\debate.ico" 0 SW_SHOWNORMAL "" "Debate Studio"
  CreateDirectory "$SMPROGRAMS\Debate Studio"
  CreateShortCut "$SMPROGRAMS\Debate Studio\Debate Studio.lnk" "$INSTDIR\Debate Studio.exe" "" "$INSTDIR\resources\debate.ico" 0 SW_SHOWNORMAL "" "Debate Studio"
!macroend

Function DebateModelSettingsPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Choose the model used to generate debate speeches:"
  Pop $0
  ${NSD_CreateRadioButton} 0 28u 100% 14u "Qwen2.5 3B - recommended for laptops"
  Pop $DebateModel3BInput
  ${NSD_CreateRadioButton} 0 47u 100% 14u "Qwen2.5 7B - balanced quality and speed"
  Pop $DebateModel7BInput
  ${NSD_CreateRadioButton} 0 66u 100% 14u "Qwen2.5 14B - best quality, high memory use"
  Pop $DebateModel14BInput
  ${NSD_Check} $DebateModel3BInput

  ${NSD_CreateLabel} 0 91u 100% 74u "The 1.5B model is always installed for topic checks and judging.$\r$\n3B: about 3 GB total model storage.$\r$\n7B: about 5.5 GB total model storage.$\r$\n14B: about 10 GB total model storage."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function DebateModelSettingsLeave
  ${NSD_GetState} $DebateModel7BInput $0
  ${If} $0 == 1
    StrCpy $InstallerDialogueModel "qwen2.5:7b"
    SectionGetSize 0 $1
    IntOp $1 $1 - ${DEBATE_MODEL_3B_SPACE_KB}
    IntOp $1 $1 + ${DEBATE_MODEL_7B_SPACE_KB}
    SectionSetSize 0 $1
    Return
  ${EndIf}
  ${NSD_GetState} $DebateModel14BInput $0
  ${If} $0 == 1
    StrCpy $InstallerDialogueModel "qwen2.5:14b"
    SectionGetSize 0 $1
    IntOp $1 $1 - ${DEBATE_MODEL_3B_SPACE_KB}
    IntOp $1 $1 + ${DEBATE_MODEL_14B_SPACE_KB}
    SectionSetSize 0 $1
  ${Else}
    StrCpy $InstallerDialogueModel "qwen2.5:3b"
  ${EndIf}
FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
Var RemoveOllama
Var InstalledDialogueModel

!macro customUnInit
  Call un.AskRemoveOllama
!macroend

!macro customUnInstall
  ${If} $RemoveOllama == "1"
    Call un.RemoveOllama
  ${EndIf}
  DeleteRegValue HKCU "Software\DebateStudio" "DialogueModel"
!macroend

Function un.AskRemoveOllama
  StrCpy $RemoveOllama "0"
  ReadRegStr $InstalledDialogueModel HKCU "Software\DebateStudio" "DialogueModel"
  StrCmp $InstalledDialogueModel "qwen2.5:7b" modelKnown
  StrCmp $InstalledDialogueModel "qwen2.5:14b" modelKnown
  StrCpy $InstalledDialogueModel "qwen2.5:3b"
  modelKnown:
  IfSilent done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also uninstall Ollama and remove $InstalledDialogueModel plus qwen2.5:1.5b? Other Ollama models will be kept." IDYES removeOllama IDNO done
  removeOllama:
    StrCpy $RemoveOllama "1"
  done:
FunctionEnd

Function un.RemoveOllama
  StrCpy $0 "$LOCALAPPDATA\Programs\Ollama"
  IfFileExists "$0\ollama.exe" ollamaFound
  StrCpy $0 "$PROGRAMFILES64\Ollama"
  IfFileExists "$0\ollama.exe" ollamaFound
  StrCpy $0 "$PROGRAMFILES\Ollama"
  IfFileExists "$0\ollama.exe" ollamaFound
  MessageBox MB_ICONEXCLAMATION|MB_OK "Ollama could not be found in its standard installation folders. Debate Studio was removed, but Ollama and its models were left in place."
  Return

  ollamaFound:
    DetailPrint "Removing $InstalledDialogueModel and qwen2.5:1.5b..."
    nsExec::ExecToLog '"$0\ollama.exe" rm $InstalledDialogueModel'
    Pop $1
    nsExec::ExecToLog '"$0\ollama.exe" rm qwen2.5:1.5b'
    Pop $2
    IfFileExists "$0\unins000.exe" uninstallOllama
    MessageBox MB_ICONEXCLAMATION|MB_OK "The Ollama uninstaller could not be found. Model cleanup was attempted, but Ollama may remain installed."
    Return

  uninstallOllama:
    DetailPrint "Uninstalling Ollama..."
    ExecWait '"$0\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART' $1
    ${If} $1 != 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "Ollama could not be fully uninstalled. Run its uninstaller manually if needed."
    ${EndIf}
FunctionEnd
!endif