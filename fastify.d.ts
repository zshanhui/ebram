import 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when POST /investigations is accepted; used to correlate async investigation logs. */
    investigationRequestId?: string
  }
}
