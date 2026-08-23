-- Runs the instant Apple Mail receives a TeamWork alert.
--
-- This is why Apple Mail is worth setting up rather than reading a mailbox over
-- an API: a Mail rule with a "Run AppleScript" action fires on arrival, so there
-- is no poll interval to lose half of. Exchange pushes to Mail, Mail runs this,
-- this posts to the local server, the server reads one day of the board and
-- claims. Nothing in that chain waits for a timer.
--
-- Install: Mail > Settings > Rules > Add Rule
--   If ALL:  From      contains  mailer@schedulesource.com
--            Subject   contains  SHIFT AVAILABLE
--   Perform: Run AppleScript  ->  this file
--
-- Mail only offers scripts saved in:
--   ~/Library/Application Scripts/com.apple.mail/
-- so install.sh copies it there. Editing the copy is what takes effect.
--
-- The rule conditions are belt to the braces, not the safety. alert.mjs checks
-- the sender and the exact subject again on the server, because a Mail rule is a
-- line in a plist that is easy to loosen by accident and the payload decides
-- which shift gets claimed.

property endpoint : "http://127.0.0.1:8123/api/alert"

using terms from application "Mail"
	on perform mail action with messages theMessages for rule theRule
		tell application "Mail"
			repeat with thisMessage in theMessages
				try
					set theSubject to subject of thisMessage
					set theSender to sender of thisMessage
					set theBody to content of thisMessage

					-- --data-urlencode does the escaping. Building JSON here
					-- instead would mean hand-rolling an escaper for a body that
					-- contains quotes, newlines and whatever TeamWork sends next.
					--
					-- -m 20 because a claim is a sign-in plus a board read plus
					-- the claim itself, and a Mail rule that hangs blocks the
					-- rest of the rules behind it.
					do shell script "/usr/bin/curl -sS -m 20 -X POST " & quoted form of endpoint & ¬
						" --data-urlencode " & quoted form of ("from=" & theSender) & ¬
						" --data-urlencode " & quoted form of ("subject=" & theSubject) & ¬
						" --data-urlencode " & quoted form of ("body=" & theBody) & ¬
						" >> /tmp/rso-mail-rule.log 2>&1"
				on error errText
					-- A failure here must not stop the other messages in the
					-- batch, and it must leave a trace: a rule that silently
					-- stopped firing looks exactly like a mailbox with no alerts
					-- in it.
					do shell script "/bin/date >> /tmp/rso-mail-rule.log; echo " & ¬
						quoted form of ("rule error: " & errText) & " >> /tmp/rso-mail-rule.log"
				end try
			end repeat
		end tell
	end perform mail action with messages
end using terms from
