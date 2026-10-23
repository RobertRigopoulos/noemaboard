/**
 * The engine talks to the network only through this interface, so the same protocol code runs
 * over Trystero (WebRTC), BroadcastChannel (other tabs of this profile) and an in-memory hub (tests).
 */

/** What we answer when a peer asks for a blob. `data` may be a Blob so big files stream from disk. */
export interface BlobReply {
  mime: string
  data: Blob | Uint8Array
}

/** What a transport hands back for a blob request (not yet verified against the hash). */
export interface BlobResult {
  mime: string
  bytes: Uint8Array
}

export interface TransportHandlers {
  onPeerJoin: (peerId: string) => void
  onPeerLeave: (peerId: string) => void
  /** Raw bytes from a peer. Untrusted. */
  onMessage: (data: Uint8Array, peerId: string) => void
  onBlobRequest: (hash: string, peerId: string) => Promise<BlobReply | null>
  /** A peer was found but no direct connection could be made (NAT); a TURN server would help. */
  onConnectFailure?: (peerId: string) => void
}

export interface RoomTransport {
  readonly selfId: string
  /** Starts the transport. Peers already present are reported through onPeerJoin afterwards. */
  connect(handlers: TransportHandlers): void
  /** Fire-and-forget delivery to the given peers. */
  send(data: Uint8Array, targets: readonly string[]): void
  /**
   * Asks one peer for a blob. Resolves null when the peer does not have it.
   * `idleTimeoutMs`: give up when no data arrived for this long.
   */
  requestBlob(hash: string, peerId: string, opts: { idleTimeoutMs: number }): Promise<BlobResult | null>
  /** Disconnects. Handlers are never called after this returns. */
  leave(): Promise<void>
}

export interface TransportOptions {
  /** Public rendezvous id derived from the board secret. */
  roomId: string
  /** Encrypts signaling for the room. */
  password: string
  /** Board id of the room's root, for diagnostics only. */
  label: string
}

export type TransportFactory = (opts: TransportOptions) => RoomTransport | Promise<RoomTransport>

/** Thrown by a factory when this environment cannot make peer-to-peer connections at all. */
export class TransportUnavailableError extends Error {
  constructor(message = 'Peer-to-peer connections are not available here') {
    super(message)
    this.name = 'TransportUnavailableError'
  }
}
