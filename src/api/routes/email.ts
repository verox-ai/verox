import { Router } from "express";
import type { EmailStore } from "src/email/store.js";

const PAGE_SIZE = 50;

export function createEmailRouter(getEmailStore: () => EmailStore | undefined): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const store = getEmailStore();
    if (!store) { res.status(503).json({ error: "Email store not available" }); return; }

    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const mailbox = typeof req.query.mailbox === "string" ? req.query.mailbox : undefined;
    const page = Math.max(0, parseInt(String(req.query.page ?? "0"), 10) || 0);

    if (q) {
      const results = store.ftsSearch(q, PAGE_SIZE);
      res.json({ emails: results, page: 0, hasMore: false, total: results.length });
      return;
    }

    const total = store.count();
    const emails = store.listPage({ mailbox, limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE });
    const hasMore = emails.length > PAGE_SIZE;
    res.json({ emails: emails.slice(0, PAGE_SIZE), page, hasMore, total });
  });

  router.get("/mailboxes", (_req, res) => {
    const store = getEmailStore();
    if (!store) { res.status(503).json({ error: "Email store not available" }); return; }
    // list distinct mailboxes via the store db — access via public list with a large limit
    const all = store.list({ limit: 10000 });
    const mailboxes = [...new Set(all.map(e => e.mailbox).filter(Boolean))].sort();
    res.json(mailboxes);
  });

  router.get("/:id", (req, res) => {
    const store = getEmailStore();
    if (!store) { res.status(503).json({ error: "Email store not available" }); return; }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const email = store.get(id);
    if (!email) { res.status(404).json({ error: "Email not found" }); return; }
    res.json(email);
  });

  router.delete("/:id", (req, res) => {
    const store = getEmailStore();
    if (!store) { res.status(503).json({ error: "Email store not available" }); return; }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const deleted = store.delete(id);
    if (!deleted) { res.status(404).json({ error: "Email not found" }); return; }
    res.json({ ok: true });
  });

  return router;
}
