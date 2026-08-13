import type { ToolDefinition } from '../types.js'
import { searchOperationsTool } from './search-operations.js'
import { callTool } from './call.js'

export { searchOperationsTool } from './search-operations.js'
export { callTool, buildPath } from './call.js'

export const universalTools: ToolDefinition[] = [searchOperationsTool, callTool]
