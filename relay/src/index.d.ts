import type { Server } from 'node:http'

export interface RelayOptions {
  /** TCP port (default 8787; 0 = random free port). */
  port?: number
  /** Interface to bind (default: all interfaces). */
  host?: string
  /** Where the database and blobs live (default ./data). */
  dataDir?: string
  /** Optional relay-wide key every client must present. */
  accessKey?: string
  /** Largest single file in MB (default 50). */
  maxBlobMB?: number
  /** Storage quota per board (updates + snapshots + files) in MB (default 1024). */
  maxRoomMB?: number
  /** Largest logical WebSocket message (e.g. a snapshot) in MB (default 32). */
  maxMessageMB?: number
  /** Maximum number of boards, 0 = unlimited. */
  maxRooms?: number
  /** Concurrent WebSockets per client IP or IPv6 /64 (default 4096; an office behind one NAT shares it). */
  maxConnectionsPerIp?: number
  /** WebSocket messages per second per IP (default 2000, burst 4x). */
  messagesPerSecond?: number
  /** HTTP requests, including WebSocket handshakes, per second per IP (default 200, burst 4x). */
  httpPerSecond?: number
  /**
   * Number of trusted reverse proxies in front of the relay (true = 1). The client IP is the
   * X-Forwarded-For entry that many places from the right; entries further left are client-supplied.
   */
  trustProxy?: boolean | number
  /** Time a socket may stay unauthenticated (default 10000 ms). */
  helloTimeoutMs?: number
  /** Keepalive ping interval (default 30000 ms). */
  pingIntervalMs?: number
  /** Logger, or false for silence (default console.log with timestamp). */
  log?: ((msg: string) => void) | false
}

export interface RelayServer {
  server: Server
  listen(port?: number, host?: string): Promise<{ port: number; host: string }>
  /** Stops accepting connections, closes sockets politely and flushes the database. */
  close(graceMs?: number): Promise<void>
  stats(): { connections: number; rooms: number }
}

export const VERSION: string
export function createRelayServer(options?: RelayOptions): RelayServer
