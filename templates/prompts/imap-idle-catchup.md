Quiet hours have ended. Check for emails that arrived during quiet hours.

Before processing: check if a knowledge document with slug "email-rules" exists (use knowledge_read slug="email-rules") and follow any rules defined there.

Then use imap_mail with command=list_new, mailbox="{{mailbox}}" to retrieve and process any missed messages.
