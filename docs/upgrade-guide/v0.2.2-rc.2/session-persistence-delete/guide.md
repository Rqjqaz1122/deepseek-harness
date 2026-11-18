---
kind: upgrade-guide
description: "Custom Session persistence backends must implement permanent deletion and its cleanup notifications."
---

# Session persistence deletion

English | [中文](guide.zh.md)

## Change

`SessionPersistence` adds the abstract `delete(id): Promise<boolean>` method. Custom subclasses no longer compile until they implement it. The shipped JSONL backend already implements the method; application users need no configuration or data migration.

## Migration

1. Implement `delete(id)` in the custom backend. Refuse active writers, close local readers, erase every stored generation, and return whether a log existed; a missing id is an idempotent no-op.
2. Await `session/deleting` before erasing logs and `session/deleted` after erasure, including on repeated deletion, so derived-data cleanup can finish after a partial failure. Preserve errors and allow retry.
3. Route product operations through `ctx.workspaceRegistry.deleteSession(id)` for activity checks, runtime release, and workspace cleanup. Verify active-writer refusal and that list, stat, open, and search cannot return the deleted history after restart.
