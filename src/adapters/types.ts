export interface RouterConfig {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number | null;
  protocol: string;
  username: string | null;
  password: string | null; // decrypted in memory only; never logged or sent to the browser
  apiPath: string | null;
  siteId: string | null;
}

export interface RouterHealthResult {
  ok: boolean;
  authenticated: boolean;
  connectedClients?: number;
  responseTimeMs: number;
  message: string;
}

export interface ConnectedWifiClient {
  macAddress: string;
  hostname?: string;
  ipAddress?: string;
  signalStrength?: number;
  interfaceName?: string;
  connectedAt?: Date;
  lastSeenAt: Date;
  routerId: string;
}

export interface WifiClientEvent {
  macAddress: string;
  type: 'CONNECTED' | 'DISCONNECTED';
  at: Date;
  ipAddress?: string;
  hostname?: string;
}

export interface AdapterCapabilities {
  /** true only when the router/controller exposes reliable connection history (not just "current clients"). */
  connectionHistory: boolean;
  /** true only when the adapter can safely disconnect/block a client. */
  disconnectClient: boolean;
}

/**
 * Contract every router brand implements. Attendance code depends ONLY on this interface.
 * getConnectedClients MUST throw on any failure (network, auth, bad response). It must never
 * return [] to mean "I could not find out" - an empty array means "the router confirmed nobody is connected".
 */
export interface WifiRouterAdapter {
  readonly capabilities: AdapterCapabilities;
  testConnection(config: RouterConfig): Promise<RouterHealthResult>;
  getConnectedClients(config: RouterConfig): Promise<ConnectedWifiClient[]>;
  getClientHistory?(config: RouterConfig, from: Date, to: Date): Promise<WifiClientEvent[]>;
  disconnectClient?(config: RouterConfig, macAddress: string): Promise<void>;
}

export class RouterAdapterError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
