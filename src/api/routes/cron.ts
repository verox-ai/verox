import { Router } from "express";
import type { CronService } from "src/cron/service.js";
import * as chrono from "chrono-node";

export function createCronRouter(cronService: CronService): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(cronService.listEntries());
  });

  router.post("/", (req, res) => {
    const { id, schedule: rawSchedule, when, prompt, targets, recurring } = req.body as {
      id?: string;
      schedule?: string;
      when?: string;
      prompt?: string;
      targets?: Array<{ channel: string; chatId: string }>;
      recurring?: boolean;
    };

    let schedule = rawSchedule;

    // Natural language 'when' → one-shot cron expression
    if (when) {
      const date = chrono.parseDate(when, new Date(), { forwardDate: true });
      if (!date || date <= new Date()) {
        res.status(400).json({ error: `Could not parse time "${when}". Try "in 2 hours" or "tomorrow at 9am".` });
        return;
      }
      const m = date.getMinutes();
      const h = date.getHours();
      const d = date.getDate();
      const mo = date.getMonth() + 1;
      schedule = `${m} ${h} ${d} ${mo} *`;
    }

    if (!schedule || !prompt || !targets?.length) {
      res.status(400).json({ error: "schedule (or when), prompt, and targets are required" });
      return;
    }
    try {
      cronService.schedule({ id, schedule, prompt, targets, recurring: when ? false : (recurring ?? true) });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.put("/:id", (req, res) => {
    const { schedule: rawSchedule, when, prompt, targets, recurring } = req.body as {
      schedule?: string; when?: string; prompt?: string;
      targets?: Array<{ channel: string; chatId: string }>; recurring?: boolean;
    };
    let schedule = rawSchedule;
    if (when) {
      const date = chrono.parseDate(when, new Date(), { forwardDate: true });
      if (!date || date <= new Date()) {
        res.status(400).json({ error: `Could not parse time "${when}".` });
        return;
      }
      schedule = `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`;
    }
    if (!schedule || !prompt || !targets?.length) {
      res.status(400).json({ error: "schedule (or when), prompt, and targets are required" });
      return;
    }
    try {
      cronService.schedule({ id: req.params.id, schedule, prompt, targets, recurring: when ? false : (recurring ?? true) });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete("/:id", (req, res) => {
    cronService.cancel(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
