---
name: status
description: Show this session's Squadra status — whether it's connected, its name and role, pending pairings, and which other sessions are alive. Use when the user types /squadra:status or asks "who am I in Squadra", "is Squadra connected" or "which workers are alive".
user-invocable: true
disable-model-invocation: true
---

# /squadra:status — squadra status

Call Squadra MCP server's `status` tool and show the user its answer,
lightly formatted. Don't call any other tool.

If it reports pending pairings, remind the user they approve them with
`/squadra:access pair <code>`. If the channel is not enabled in this session,
show the launch command it gives.
