---
name: browser-swarm-__N__
description: __DESCRIPTION__
model: sonnet
mcpServers:
  - playwright__N__:
      type: stdio
      command: __DIR__/browser-swarm-mcp.sh
      args: ["__NODE__", "__N__"]
---

__PROMPT__
