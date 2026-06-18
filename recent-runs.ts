import { Agent } from '@cursor/sdk'
import { config } from './config.js'

async function main() {
  const agents = await Agent.list({ runtime: 'cloud', limit: 50, apiKey: config.cursorApiKey })
  console.log('Agents:', agents.items.length, '\n')

  const allRuns: any[] = []
  for (const agent of agents.items) {
    const runs = await Agent.listRuns(agent.agentId, { runtime: 'cloud', limit: 5, apiKey: config.cursorApiKey })
    for (const item of runs.items) {
      allRuns.push({
        agentId: agent.agentId,
        id: item.id,
        status: item._status,
        result: item._result,
        createdAt: item.createdAt,
        durationMs: item._durationMs,
      })
    }
  }

  allRuns.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  const recent = allRuns.slice(0, 3)

  for (const r of recent) {
    console.log('---')
    console.log('run:', r.id)
    console.log('agent:', r.agentId)
    console.log('dashboard:', 'https://cursor.com/agents/' + r.agentId)
    console.log('status:', r.status)
    console.log('duration:', r.durationMs ? `${(r.durationMs / 1000).toFixed(0)}s` : '?')
    console.log('created:', new Date(r.createdAt).toISOString())
    if (r.result) console.log('result:', String(r.result).slice(0, 200))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
