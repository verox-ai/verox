#!/usr/bin/env node
import "reflect-metadata";
import { program } from "commander";
import { VERSION } from "src/version.js";
import { registerStart } from "./commands/start.js";
import { registerConfig } from "./commands/config.js";
import { registerMemory } from "./commands/memory.js";
import { registerCron } from "./commands/cron.js";
import { registerService } from "./commands/service.js";
import { registerVault } from "./commands/vault.js";
import { registerSkills } from "./commands/skills.js";
import { registerMessage } from "./commands/message.js";
import { registerDocs } from "./commands/docs.js";

program
  .name("verox")
  .description(`Verox CLI (${VERSION}) — manage config, memory, cron jobs and start the agent`)
  .version(VERSION);

registerStart(program);
registerConfig(program);
registerMemory(program);
registerCron(program);
registerService(program);
registerVault(program);
registerSkills(program);
registerMessage(program);
registerDocs(program);
program.parse();
