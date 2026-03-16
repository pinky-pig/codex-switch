use AppleScript version "2.7"
use framework "Foundation"
use framework "AppKit"
use scripting additions

property ca : current application
property statusItem : missing value
property statusMenu : missing value
property stateCache : missing value
property cliEntryPath : "__CLI_ENTRY__"
property nodeBinPath : "__NODE_BIN__"
property logFileName : "codex-switch-menubar.log"

on run
	my setupStatusItem()
	return
end run

on idle
	try
		my rebuildMenu()
	end try
	return 90
end idle

on quit
	if statusItem is not missing value then
		(ca's NSStatusBar's systemStatusBar()'s removeStatusItem:statusItem)
	end if
	continue quit
end quit

on setupStatusItem()
	set statusItem to (ca's NSStatusBar's systemStatusBar()'s statusItemWithLength:(ca's NSVariableStatusItemLength))
	my logMessage("setupStatusItem")
	(statusItem's button()'s setTitle:"cxs")
	(statusItem's button()'s setToolTip:"codex-switch")
	my rebuildMenu()
end setupStatusItem

on rebuildMenu()
	set statusMenu to ca's NSMenu's alloc()'s initWithTitle:"codex-switch"
	my logMessage("rebuildMenu")
	
	if my canRunCLI() is false then
		my logMessage("canRunCLI=false")
		my addDisabledItem("未找到可用的 codex-switch CLI")
		my addSeparator()
		my addActionItem("刷新", "refreshMenu:")
		my addActionItem("退出", "quitApp:")
		statusItem's setMenu:statusMenu
		return
	end if
	
	try
		set stateCache to my fetchAppState()
	on error errorMessage
		my logMessage("fetchAppState error: " & errorMessage)
		set stateCache to missing value
		my addDisabledItem("读取状态失败")
		my addDisabledItem(errorMessage)
		my addSeparator()
		my addActionItem("刷新", "refreshMenu:")
		my addActionItem("退出", "quitApp:")
		statusItem's setMenu:statusMenu
		return
	end try
	
	my addCurrentInfo()
	my addSeparator()
	my addSavedAccountsInfo()
	my addSeparator()
	my addActionItem("切换账号…", "switchAccount:")
	my addActionItem("保存当前使用的 Codex 账号到工具中", "saveCurrentAccount:")
	my addActionItem("删除 Codex 账号…", "deleteAccount:")
	my addActionItem("刷新", "refreshMenu:")
	my addSeparator()
	my addActionItem("添加 Codex 账号", "addAccount:")
	my addActionItem("退出", "quitApp:")
	statusItem's setMenu:statusMenu
end rebuildMenu

on addCurrentInfo()
	set runtimeState to my dictValue(stateCache, "runtime")
	set currentAccount to my dictValue(runtimeState, "current")
	
	my addDisabledItem("当前生效账号")
	if currentAccount is missing value then
		my addDisabledItem("  n/a")
	else
		my addDisabledItem("  " & my displayValue(my dictValue(currentAccount, "email")))
		my addDisabledItem("  expires: " & my compactTime(my dictValue(currentAccount, "expiresAt")))
	end if
	
	my addDisabledItem("  auth: " & my displayValue(my dictValue(runtimeState, "authPath")))
	my addDisabledItem("  config: " & my displayValue(my dictValue(runtimeState, "configPath")))
end addCurrentInfo

on addSavedAccountsInfo()
	set accountsArray to my dictValue(stateCache, "accounts")
	my addDisabledItem("已保存账号")
	
	if accountsArray is missing value then
		my addDisabledItem("  n/a")
		return
	end if
	
	set accountCount to (accountsArray's |count|()) as integer
	if accountCount is 0 then
		my addDisabledItem("  暂无已保存账号")
		return
	end if
	
	repeat with index from 0 to (accountCount - 1)
		set accountItem to accountsArray's objectAtIndex:index
		set displayName to my displayValue(my dictValue(accountItem, "name"))
		set summaryValue to my dictValue(accountItem, "summary")
		set accountEmail to my displayValue(my dictValue(summaryValue, "email"))
		set expiresValue to my compactTime(my dictValue(summaryValue, "expiresAt"))
		set activeMark to ""
		if my boolValue(my dictValue(accountItem, "active")) then
			set activeMark to "  active"
		end if
		
		my addDisabledItem("  " & (index + 1) & ". " & accountEmail & activeMark)
		my addDisabledItem("     name: " & displayName & "  expires: " & expiresValue)
	end repeat
end addSavedAccountsInfo

on addDisabledItem(itemTitle)
	set itemRef to (ca's NSMenuItem's alloc()'s initWithTitle:itemTitle action:(missing value) keyEquivalent:"")
	itemRef's setEnabled:false
	statusMenu's addItem:itemRef
end addDisabledItem

on addActionItem(itemTitle, actionName)
	set itemRef to (ca's NSMenuItem's alloc()'s initWithTitle:itemTitle action:actionName keyEquivalent:"")
	itemRef's setTarget:me
	statusMenu's addItem:itemRef
end addActionItem

on addSeparator()
	statusMenu's addItem:(ca's NSMenuItem's separatorItem())
end addSeparator

on refreshMenu_(sender)
	my rebuildMenu()
end refreshMenu_

on saveCurrentAccount_(sender)
	try
		set resultText to my runCLI("save-current-auto")
		set resultValue to my parseJSON(resultText)
		set savedName to my displayValue(my dictValue(resultValue, "name"))
		if my boolValue(my dictValue(resultValue, "created")) then
			display notification ("已保存为 " & savedName) with title "codex-switch"
		else
			display notification ("账号已存在：" & savedName) with title "codex-switch"
		end if
		my rebuildMenu()
	on error errorMessage
		display dialog errorMessage buttons {"好"} default button "好" with title "codex-switch"
	end try
end saveCurrentAccount_

on switchAccount_(sender)
	try
		set selectedName to my chooseAccountName("选择要切换的 Codex 账号：", "切换")
		if selectedName is false then
			return
		end if
		
		my runCLI("use " & quoted form of selectedName)
		display notification ("已切换到 " & selectedName) with title "codex-switch"
		my rebuildMenu()
	on error errorMessage
		display dialog errorMessage buttons {"好"} default button "好" with title "codex-switch"
	end try
end switchAccount_

on deleteAccount_(sender)
	try
		set selectedName to my chooseAccountName("选择要删除的 Codex 账号：", "删除")
		if selectedName is false then
			return
		end if
		
		set confirmResult to display dialog ("确认删除 " & selectedName & " ?") buttons {"取消", "删除"} default button "删除" cancel button "取消" with title "codex-switch"
		if button returned of confirmResult is not "删除" then
			return
		end if
		
		my runCLI("remove " & quoted form of selectedName)
		display notification ("已删除 " & selectedName) with title "codex-switch"
		my rebuildMenu()
	on error errorMessage
		display dialog errorMessage buttons {"好"} default button "好" with title "codex-switch"
	end try
end deleteAccount_

on addAccount_(sender)
	try
		set resultText to my runCLI("add-account")
		set resultValue to my parseJSON(resultText)
		set messageText to my displayValue(my dictValue(resultValue, "message"))
		if messageText is "n/a" then
			set messageText to "已触发添加账号流程。"
		end if
		display notification messageText with title "codex-switch"
		my rebuildMenu()
	on error errorMessage
		display dialog errorMessage buttons {"好"} default button "好" with title "codex-switch"
	end try
end addAccount_

on quitApp_(sender)
	quit
end quitApp_

on chooseAccountName(promptText, okLabel)
	set accountsArray to my dictValue(stateCache, "accounts")
	if accountsArray is missing value then
		error "当前没有已保存账号。"
	end if
	
	set accountCount to (accountsArray's |count|()) as integer
	if accountCount is 0 then
		error "当前没有已保存账号。"
	end if
	
	set displayList to {}
	repeat with index from 0 to (accountCount - 1)
		set accountItem to accountsArray's objectAtIndex:index
		set end of displayList to my displayValue(my dictValue(accountItem, "name"))
	end repeat
	
	set selectedItems to choose from list displayList with prompt promptText OK button name okLabel cancel button name "取消"
	if selectedItems is false then
		return false
	end if
	
	return item 1 of selectedItems
end chooseAccountName

on fetchAppState()
	return my parseJSON(my runCLI("app-state"))
end fetchAppState

on runCLI(argumentsText)
	set commandText to my buildCLICommand(argumentsText)
	if commandText is missing value then
		my logMessage("runCLI missing command for " & argumentsText)
		error "未找到可用的 codex-switch CLI。"
	end if
	
	my logMessage("runCLI " & commandText)
	return do shell script ((my shellPrefix()) & commandText)
end runCLI

on canRunCLI()
	try
		return (my buildCLICommand("app-state")) is not missing value
	on error
		return false
	end try
end canRunCLI

on buildCLICommand(argumentsText)
	try
		if cliEntryPath is not "" and nodeBinPath is not "" then
			return quoted form of nodeBinPath & space & quoted form of cliEntryPath & space & argumentsText
		end if
	on error
	end try
	
	try
		set outputText to do shell script ((my shellPrefix()) & "command -v cxs || command -v codex-switch || true")
		if outputText is not "" then
			return quoted form of outputText & space & argumentsText
		end if
	on error
	end try
	
	return missing value
end buildCLICommand

on logMessage(messageText)
	try
		set logPath to ((POSIX path of (path to home folder)) & "Library/Logs/" & logFileName)
		set timestampText to do shell script "date '+%F %T'"
		set quotedMessage to quoted form of (timestampText & " " & messageText)
		do shell script "printf %s\\\\n " & quotedMessage & " >> " & quoted form of logPath
	end try
end logMessage

on shellPrefix()
	return "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/sbin:/usr/sbin:/sbin:$PATH; "
end shellPrefix

on parseJSON(jsonText)
	set jsonString to ca's NSString's stringWithString:jsonText
	set jsonData to jsonString's dataUsingEncoding:(ca's NSUTF8StringEncoding)
	set errorRef to reference
	set parsedValue to ca's NSJSONSerialization's JSONObjectWithData:jsonData options:0 |error|:errorRef
	if parsedValue is missing value then
		set errorValue to contents of errorRef
		if errorValue is missing value then
			error "JSON parse failed."
		end if
		
		error (errorValue's localizedDescription() as text)
	end if
	
	return parsedValue
end parseJSON

on dictValue(dictRef, keyName)
	if dictRef is missing value then
		return missing value
	end if
	
	set valueRef to dictRef's objectForKey:keyName
	if valueRef is missing value then
		return missing value
	end if
	
	if valueRef is (ca's NSNull's null()) then
		return missing value
	end if
	
	return valueRef
end dictValue

on boolValue(valueRef)
	if valueRef is missing value then
		return false
	end if
	
	try
		return (valueRef as boolean)
	on error
		return false
	end try
end boolValue

on displayValue(valueRef)
	if valueRef is missing value then
		return "n/a"
	end if
	
	try
		return valueRef as text
	on error
		return "n/a"
	end try
end displayValue

on compactTime(valueRef)
	set rawValue to my displayValue(valueRef)
	if rawValue is "n/a" then
		return rawValue
	end if
	
	set AppleScript's text item delimiters to "T"
	if (count of text items of rawValue) > 1 then
		set compactValue to (text item 1 of rawValue) & " " & text item 2 of rawValue
	else
		set compactValue to rawValue
	end if
	set AppleScript's text item delimiters to "."
	if (count of text items of compactValue) > 1 then
		set compactValue to text item 1 of compactValue
	end if
	set AppleScript's text item delimiters to "+"
	if (count of text items of compactValue) > 1 then
		set compactValue to text item 1 of compactValue
	end if
	set AppleScript's text item delimiters to "Z"
	if (count of text items of compactValue) > 1 then
		set compactValue to text item 1 of compactValue
	end if
	set AppleScript's text item delimiters to ""
	return compactValue
end compactTime
