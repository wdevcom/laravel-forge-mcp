import type { ToolDefinition } from './types.js'
import { universalTools } from './universal/index.js'
import { contextTools } from './curated/context.js'
import { serverTools } from './curated/servers.js'
import { deploymentTools } from './curated/deployments.js'
import { siteConfigTools } from './curated/site-config.js'
import { diagnosticTools } from './curated/diagnostics.js'
import { processTools } from './curated/processes.js'

export const curatedTools: ToolDefinition[] = [
  ...contextTools,
  ...serverTools,
  ...deploymentTools,
  ...siteConfigTools,
  ...diagnosticTools,
  ...processTools,
]

export const allTools: ToolDefinition[] = [...curatedTools, ...universalTools]
