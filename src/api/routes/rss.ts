import { Router } from "express";
import type { RssService } from "src/rss/service.js";

export function createRssRouter(rssService: RssService): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    try { res.json(rssService.list()); } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post("/", async (req, res) => {
    const { url, name, channel, chatId, schedule, manual } = req.body as Record<string, string>;
    if (!url || !name) {
      res.status(400).json({ error: "url and name are required" }); return;
    }
    const isManual = manual === "true" || manual === true as unknown || !schedule;
    if (!isManual && (!channel || !chatId)) {
      res.status(400).json({ error: "channel and chatId are required for auto-monitored subscriptions" }); return;
    }
    try {
      const targets = channel && chatId ? [{ channel, chatId }] : [];
      const id = rssService.subscribe({ url, name, targets, schedule: schedule || undefined, manual: isManual });
      res.json({ ok: true, id });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch("/:id", (req, res) => {
    const { url, name, channel, chatId, schedule, manual } = req.body as Record<string, string>;
    const isManual = manual === "true" || manual === true as unknown;
    const targets = channel && chatId ? [{ channel, chatId }] : undefined;
    const ok = rssService.update(req.params.id, {
      ...(url && { url }),
      ...(name && { name }),
      ...(targets && { targets }),
      ...(schedule !== undefined && { schedule }),
      ...(manual !== undefined && { manual: isManual }),
    });
    if (!ok) { res.status(404).json({ error: "Subscription not found" }); return; }
    res.json({ ok: true });
  });

  router.delete("/:id", (req, res) => {
    const ok = rssService.unsubscribe(req.params.id);
    if (!ok) { res.status(404).json({ error: "Subscription not found" }); return; }
    res.json({ ok: true });
  });

  return router;
}
