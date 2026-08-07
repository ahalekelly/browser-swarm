---
name: browser-swarm
description: __DESCRIPTION__
model: sonnet
mcpServers:
  - playwright:
      type: stdio
      command: __NODE__
      args: ["__DIR__/src/launch.ts", "chromium"]
---

__PROMPT__
