import { Agent } from '@cursor/sdk'
import { config } from './config.js'

async function findAgentIdForRun(runId: string): Promise<string | undefined> {
  const agents = await Agent.list({ runtime: 'cloud', limit: 50, apiKey: config.cursorApiKey })

  for (const agent of agents.items) {
    const runs = await Agent.listRuns(agent.agentId, {
      runtime: 'cloud',
      limit: 20,
      apiKey: config.cursorApiKey,
    })
    if (runs.items.some((run) => run.id === runId)) {
      return agent.agentId
    }
  }

  return undefined
}

function printAssistantSteps(turns: Awaited<ReturnType<import('@cursor/sdk').Run['conversation']>>) {
  for (const turn of turns) {
    if (turn.type !== 'agentConversationTurn') continue
    for (const step of turn.turn.steps) {
      if (step.type === 'assistantMessage') {
        console.log('\n--- assistant ---')
        console.log(step.message.text)
      } else if (step.type === 'toolCall') {
        console.log(`\n--- tool: ${step.message.type} (${step.message.result?.status ?? 'unknown'}) ---`)
        if ('args' in step.message) {
          console.log('args:', JSON.stringify(step.message.args, null, 2))
        }
        if (step.message.result) {
          const { status, ...rest } = step.message.result
          const keys = Object.keys(rest)
          if (keys.length > 0) {
            const detail = JSON.stringify(rest, null, 2)
            if (detail.length > 2000) {
              console.log('output:', detail.slice(0, 2000) + '...')
            } else {
              console.log('output:', detail)
            }
          }
        }
      }
    }
  }
}

const runId = process.argv[2]
if (!runId) {
  console.error('usage: pnpm inspect-run <run-id>')
  process.exit(1)
}

const agentId = process.argv[3] ?? await findAgentIdForRun(runId)
if (!agentId) {
  console.error(`no cloud agent found for run ${runId}`)
  console.error('tip: pass agent id as second arg if you have it: pnpm inspect-run <run-id> <bc-...>')
  process.exit(1)
}

console.log(`agentId: ${agentId}`)
console.log(`dashboard: https://cursor.com/agents/${agentId}`)

const run = await Agent.getRun(runId, {
  runtime: 'cloud',
  agentId,
  apiKey: config.cursorApiKey,
})

console.log('\n--- summary ---')
console.log('status:', run.status)
console.log('result:', run.result ?? '(none)')

if (run.supports('conversation')) {
  const turns = await run.conversation()
  printAssistantSteps(turns)
} else {
  console.error('conversation unsupported:', run.unsupportedReason('conversation'))
}
