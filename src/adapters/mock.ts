import type { ConnectedWifiClient, RouterConfig, RouterHealthResult, WifiRouterAdapter } from './types.ts';
import { RouterAdapterError } from './types.ts';

/**
 * Development/test adapter. Besides the in-memory test hooks, a MOCK router can be driven from the UI for demos:
 * put a comma-separated list of MAC addresses in its "API path" field to simulate those clients being connected,
 * or the word FAIL to simulate an unreachable router. State is held in memory per router id and driven by a script:
 * MockRouterState.setClients(...) / setFailing(...). It is NOT a real router integration.
 */
interface MockClient { mac: string; hostname?: string; ip?: string; signal?: number }
const state = new Map<string, { clients: MockClient[]; failing: string | null }>();

function get(id: string) {
  let s = state.get(id);
  if (!s) { s = { clients: [], failing: null }; state.set(id, s); }
  return s;
}

export const MockRouterState = {
  setClients(routerId: string, clients: MockClient[]) { get(routerId).clients = clients; },
  setFailing(routerId: string, reason: string | null) { get(routerId).failing = reason; },
  reset() { state.clear(); },
};

export class MockAdapter implements WifiRouterAdapter {
  readonly capabilities = { connectionHistory: false, disconnectClient: false };

  async testConnection(config: RouterConfig): Promise<RouterHealthResult> {
    const scripted = state.has(config.id);
    const s = get(config.id);
    if (!scripted && config.apiPath?.trim().toUpperCase() === 'FAIL') return { ok: false, authenticated: false, responseTimeMs: 1, message: 'Simulated failure' };
    if (s.failing) return { ok: false, authenticated: false, responseTimeMs: 1, message: s.failing };
    return { ok: true, authenticated: true, connectedClients: s.clients.length, responseTimeMs: 1, message: 'Mock router OK' };
  }

  async getConnectedClients(config: RouterConfig): Promise<ConnectedWifiClient[]> {
    const scripted = state.has(config.id);
    const s = get(config.id);
    if (s.failing) throw new RouterAdapterError('ROUTER_UNREACHABLE', s.failing);
    const now = new Date();
    if (!scripted && config.apiPath) { // UI-driven demo mode
      if (config.apiPath.trim().toUpperCase() === 'FAIL') throw new RouterAdapterError('ROUTER_UNREACHABLE', 'Simulated failure');
      return config.apiPath.split(',').map((m) => m.trim()).filter(Boolean).map((mac) => ({ macAddress: mac, lastSeenAt: now, routerId: config.id }));
    }
    return s.clients.map((c) => ({
      macAddress: c.mac, hostname: c.hostname, ipAddress: c.ip, signalStrength: c.signal,
      lastSeenAt: now, routerId: config.id,
    }));
  }
}
