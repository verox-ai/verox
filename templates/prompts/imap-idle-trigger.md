New email arrived in {{mailbox}}.

Before processing: check if a knowledge document with slug "email-rules" exists (use knowledge_read slug="email-rules") and follow any rules defined there.

Then use imap_mail with command=list_new, mailbox="{{mailbox}}" to retrieve and process new messages.

After reading each email with imap_read, decide whether it is worth archiving:
- If yes (useful information, ongoing topic, known contact, action required): call email_save with:
  - message_id: the message_id from imap_read (RFC 2822 header — stable across folder moves)
  - uid + mailbox: from imap_read
  - from_addr, to_addr, subject, received_at: from imap_read
  - raw_body: the full verbatim "content" field from imap_read — paste it as-is, do not truncate
  - body: your concise summary (key facts, action items, why this email matters)
- If no (spam, newsletter, automated notification, one-off): skip email_save.

If you need context from previous emails on the same topic (e.g. earlier messages from the same sender or a related problem), use email_search — do NOT use memory_search for email content.
Example: email_search query="pump failure warranty" will surface all archived emails related to that topic across all senders.
