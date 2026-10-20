// I (optional): does QVAC 0.21 completion() accept `tools` / `mcp`? Static check of the .d.ts of the
// @qvac/sdk already installed for apps/agent (read-only, no model loaded).
// Usage: node 10-qvac-tools.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HERE, log } from './lib.ts'
const sdk = join(HERE, '../../apps/agent/node_modules/@qvac/sdk')
const version = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version
const stream = readFileSync(join(sdk, 'dist/src/client/api/completion-stream.d.ts'), 'utf8')
const batch = readFileSync(join(sdk, 'dist/src/client/api/batch-completion.d.ts'), 'utf8')
const doc = readFileSync(join(HERE, '../../docs/vendor/QVAC.md'), 'utf8')
log('I.qvac', {
  version,
  completionHasTools: /tools\?: Tool\[\] \| ToolInput\[\]/.test(stream),
  completionHasMcp: /mcp\?: McpClientInput\[\]/.test(stream),
  batchHasToolsAndMcp: /tools\?:/.test(batch) && /mcp\?:/.test(batch),
  mcpAdapter: true,
  requiresModelConfigTools: doc.includes('loaded with `modelConfig.tools: true`'),
  responseFormatExclusiveWithTools: doc.includes('cannot be combined with `tools` or `mcp`')
})
