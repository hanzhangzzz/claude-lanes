Output demo.gif
Set Shell bash
Set FontSize 15
Set Width 1100
Set Height 640
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Hide
Type `export PATH="/tmp/claude-lanes-gate/bin:$PATH" CLAUDE_LANES_CONFIG_DIR=/tmp/claude-lanes-demo CLAUDE_LANES_SETTINGS=/tmp/claude-lanes-gate/settings-lanes.json PS1="$ " && clear`
Enter
Show

# scene 1: lanes list
Type "c"
Enter
Sleep 4s

# scene 2: pin this window to lane 0, real session
Hide
Type "clear"
Enter
Show
Type "c 0"
Enter
Sleep 8s
Type "1+1=? reply with just the number"
Sleep 600ms
Enter
Sleep 20s
Screenshot f-answer.png
Sleep 1s
Type "/exit"
Sleep 800ms
Enter
Sleep 2s

# scene 3: openai-protocol lane via local translation proxy
Hide
Type "clear"
Enter
Show
Type "c 8"
Enter
Sleep 3s
Screenshot f-proto.png
Sleep 2s
Ctrl+C
Sleep 400ms
Ctrl+C
Sleep 1.5s

# scene 4: team mode — leader and teammates split
Hide
Type "clear"
Enter
Show
Type "c team 0 0"
Enter
Sleep 6.5s
Ctrl+C
Sleep 400ms
Ctrl+C
Sleep 2.5s
Screenshot f-cleanup.png

# end card
Type "# npm i -g claude-lanes"
Sleep 3s
