import { Router } from "express";
import type { McpServerStatus } from "src/mcp/service.js";

export function createMcpRouter(getMcpStatus: () => McpServerStatus[]): Router {
  const router = Router();

  /** GET /api/mcp/status — returns connection state for all configured MCP servers. */
  router.get("/status", (_req, res) => {
    res.json(getMcpStatus());
  });

  return router;
}
