; ═══════════════════════════════════════════════
;  NSIS 安装程序钩子 - 智能抽号系统
;  由 Tauri 在安装/卸载时注入执行
; ═══════════════════════════════════════════════

; ── 完成页面引导文字 ──
; hooks 文件在 MUI_PAGE_FINISH 之前引入,此处设置的 define 会生效
!define MUI_FINISHPAGE_TITLE "安装完成 - 智能抽号系统"
!define MUI_FINISHPAGE_TEXT "智能抽号系统已成功安装到：$\r$\n  $INSTDIR$\r$\n$\r$\n使用方式：$\r$\n  • 桌面快捷方式「智能抽号系统」默认打开抽号界面$\r$\n  • 需要设置时，点击抽号界面内的「切换到设置」按钮$\r$\n  • 开始菜单 →「智能抽号系统」文件夹内有「抽号程序」和「设置程序」两个入口$\r$\n$\r$\n点击「完成」退出安装向导。"

!macro NSIS_HOOK_POSTINSTALL
  ; ── 清理旧版本残留快捷方式(升级场景) ──
  Delete "$DESKTOP\智能抽号系统 - 抽号程序.lnk"
  Delete "$DESKTOP\智能抽号系统 - 设置程序.lnk"

  ; ── 桌面：删除 Tauri 默认快捷方式,重建为中文命名 + 独立 ico 图标 ──
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  CreateShortcut \
    "$DESKTOP\智能抽号系统.lnk" \
    "$INSTDIR\${MAINBINARYNAME}.exe" \
    "" \
    "$INSTDIR\icons\icon.ico" 0

  ; ── 开始菜单：删除 Tauri 默认快捷方式,重建抽号+设置两个入口 ──
  CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
  Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"

  CreateShortcut \
    "$SMPROGRAMS\$AppStartMenuFolder\抽号程序.lnk" \
    "$INSTDIR\${MAINBINARYNAME}.exe" \
    "" \
    "$INSTDIR\icons\icon.ico" 0

  CreateShortcut \
    "$SMPROGRAMS\$AppStartMenuFolder\设置程序.lnk" \
    "$INSTDIR\${MAINBINARYNAME}.exe" \
    "--settings" \
    "$INSTDIR\icons\icon.ico" 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; ── 桌面 ──
  Delete "$DESKTOP\智能抽号系统.lnk"
  Delete "$DESKTOP\智能抽号系统 - 抽号程序.lnk"
  Delete "$DESKTOP\智能抽号系统 - 设置程序.lnk"
  ; ── 开始菜单文件夹(含全部内容) ──
  ; 用硬编码文件夹名,卸载时 $AppStartMenuFolder 不一定可用
  Delete "$SMPROGRAMS\智能抽号系统\抽号程序.lnk"
  Delete "$SMPROGRAMS\智能抽号系统\设置程序.lnk"
  Delete "$SMPROGRAMS\智能抽号系统\${PRODUCTNAME}.lnk"
  RMDir "$SMPROGRAMS\智能抽号系统"
!macroend
