// The phone extension as a stdio MCP server, with the callback watcher beside it, until its host goes.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { Effect, Layer } from "effect"
import { AppEvents, Models, OUTBOX_FILE, serve } from "switch-ext-kit"

import { phoneApp } from "./app.ts"
import { watching } from "./watch.ts"

await Effect.runPromise(
  Effect.scoped(Effect.flatten(serve(phoneApp, new StdioServerTransport()))).pipe(
    Effect.provide(
      Layer.provideMerge(
        watching,
        Layer.provideMerge(Models.layer, AppEvents.layer(phoneApp, OUTBOX_FILE)),
      ),
    ),
  ),
)
process.exit(0)
