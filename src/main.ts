import { timingSafeEqual } from 'node:crypto'
import rateLimit from '@fastify/rate-limit'
import fastifySwagger from '@fastify/swagger'
import scalarApiReference from '@scalar/fastify-api-reference'
import Fastify from 'fastify'
import { config } from './config.js'
import { logger } from './logger.js'
import { BugFixAgentService } from './service.js'
import { closeRecordStore } from './store.js'
import { generateInvestigationRequestId } from './utils.js'

const { port, host, apiAccessKey } = config

function secureCompare(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

function extractAccessKey(request: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const authorization = request.headers.authorization
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim()
  }

  const apiKeyHeader = request.headers['x-api-key']
  if (typeof apiKeyHeader === 'string') {
    return apiKeyHeader.trim()
  }

  return undefined
}

function isPublicRoute(url: string): boolean {
  return url === '/reference' || url.startsWith('/reference/')
}

const unauthorizedResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string', const: 'unauthorized' },
  },
  required: ['error'],
} as const

const service = new BugFixAgentService()

const fastify = Fastify({
  logger: false,
})

await fastify.register(rateLimit, {
  global: true,
  max: config.rateLimitMax,
  timeWindow: config.rateLimitWindow,
  allowList: (request) => isPublicRoute(request.url),
  keyGenerator: (request) => request.ip,
})

await fastify.register(fastifySwagger, {
  openapi: {
    openapi: '3.1.0',
    info: {
      title: 'bugfixagent API',
      description:
        'Orchestrates Cursor cloud agent triage for LevelChinese News bug reports. Long-running investigations are accepted asynchronously.',
      version: '1.0.0',
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Set Authorization to `Bearer <API_ACCESS_KEY>`.',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Alternative to Bearer auth; pass `API_ACCESS_KEY` in the X-API-Key header.',
        },
      },
    },
    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
  },
})

await fastify.register(scalarApiReference, {
  routePrefix: '/reference',
  configuration: {
    title: 'bugfixagent API',
  },
})

fastify.addHook('onRequest', async (request, reply) => {
  if (isPublicRoute(request.url)) return

  const provided = extractAccessKey(request)
  if (!provided || !secureCompare(provided, apiAccessKey)) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
})

fastify.addHook('onResponse', async (request, reply) => {
  logger.info('request completed', {
    ...(request.investigationRequestId
      ? { investigationRequestId: request.investigationRequestId }
      : {}),
    method: request.method,
    url: request.url,
    statusCode: reply.statusCode,
    durationMs: Math.round(reply.elapsedTime),
  })
})

fastify.get('/health', {
  schema: {
    tags: ['System'],
    summary: 'Health check',
    response: {
      200: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          service: { type: 'string' },
          ts: { type: 'string', format: 'date-time' },
        },
        required: ['ok', 'service', 'ts'],
      },
      401: unauthorizedResponseSchema,
    },
  },
}, async () => ({
  ok: true,
  service: 'bugfixagent',
  ts: new Date().toISOString(),
}))

fastify.post('/investigations', {
  schema: {
    tags: ['Investigations'],
    summary: 'Submit a bug report for agent triage',
    description:
      'Starts an asynchronous investigation workflow. The server returns immediately with 202 Accepted while the bugfix agent runs in the background.',
    body: {
      type: 'object',
      required: ['message'],
      properties: {
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 12_000,
          description: 'Raw bug report text from the user.',
        },
      },
    },
    response: {
      202: {
        type: 'object',
        properties: {
          accepted: { type: 'boolean' },
          investigationRequestId: {
            type: 'string',
            format: 'uuid',
            description: 'Correlation id for logs and async investigation tracking.',
          },
        },
        required: ['accepted', 'investigationRequestId'],
      },
      401: unauthorizedResponseSchema,
    },
  },
}, async (request, reply) => {
  const { message } = request.body as { message: string }

  request.investigationRequestId = generateInvestigationRequestId()
  const { investigationRequestId } = request

  service.startInvestigation(investigationRequestId, message)

  return reply.code(202).send({ accepted: true, investigationRequestId })
})

const shutdown = async (signal: string) => {
  logger.info('shutting down', { signal })
  await fastify.close()
  closeRecordStore()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await fastify.listen({ port, host })
  logger.info('server listening', { port, host, docs: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/reference` })
} catch (error) {
  logger.error('failed to start server', { error })
  process.exit(1)
}
