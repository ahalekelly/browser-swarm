---
name: browser-swarm-firefox
description: Headless-Firefox swarm agent for sites where Chromium is blocked but Firefox renders (Akamai, notably). Owns a cheap isolated context on one shared Firefox process. Use plain browser-swarm unless the site is confirmed to block Chromium. Sessions idle for 5 minutes are reaped; relaunch when browser work resumes.
model: sonnet
mcpServers:
  - firefox:
      type: stdio
      command: __NODE__
      args: ["__DIR__/src/launch.ts", "firefox"]
---

__PROMPT__
