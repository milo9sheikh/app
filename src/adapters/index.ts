import type { WifiRouterAdapter } from './types.ts';
import { MockAdapter } from './mock.ts';

/**
 * Adapter registry. To add a real router brand:
 *   1. implement WifiRouterAdapter (see docs/ROUTER_ADAPTERS.md),
 *   2. register it below under its `type` key.
 * No real-brand adapter is shipped because the router model/API for this deployment is not known yet.
 */
const registry: Record<string, () => WifiRouterAdapter> = {
  MOCK: () => new MockAdapter(),
};

export const ROUTER_TYPES = Object.keys(registry);

export function getAdapter(type: string): WifiRouterAdapter {
  const factory = registry[type];
  if (!factory) throw new Error(`No adapter implemented for router type "${type}"`);
  return factory();
}
