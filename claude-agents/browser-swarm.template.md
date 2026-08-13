---
name: __NAME__
description: __DESCRIPTION__
model: sonnet
mcpServers:
  - __SERVER_NAME__:
      type: stdio
      command: __NODE__
      args: ["__DIR__/src/launch.ts", "__BROWSER__"]
---

__PROMPT__
