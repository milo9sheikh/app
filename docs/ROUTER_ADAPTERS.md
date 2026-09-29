# Router adapters

Attendance logic never talks to a router directly. It only uses the `WifiRouterAdapter` interface in
`src/adapters/types.ts`. **No real router brand is implemented yet** because the router model/firmware/API for your
deployment is not known; only a `MOCK` adapter ships. Do not treat MOCK as a production integration.

## Contract
| Method | Required | Meaning |
|---|---|---|
| `testConnection(config)` | yes | Connectivity + auth check; returns `{ok, authenticated, connectedClients, responseTimeMs, message}` |
| `getConnectedClients(config)` | yes | Currently associated clients, each with a MAC. |
| `getClientHistory(config, from, to)` | no | Only if the router/controller really keeps connection history. |
| `disconnectClient(config, mac)` | no | Only if it can be done safely. Blocking is not exposed in the UI otherwise. |
| `capabilities` | yes | `{ connectionHistory, disconnectClient }` |

**Hard rule:** `getConnectedClients` must **throw** on any failure (timeout, auth, HTTP error, malformed response).
Returning `[]` means "the router confirmed nobody is connected". If an adapter swallows errors into `[]`, the system
will believe everyone left. The sync layer records a thrown error as a router outage, keeps attendance PENDING and
flags it for review instead of marking people absent.

## Adding a real adapter (e.g. MikroTik, OpenWrt, UniFi, Omada)
1. Collect: brand, model, firmware, router IP, API type/port, auth method, whether it lists clients with MACs, whether it
   keeps history or first-seen times.
2. Create `src/adapters/<brand>.ts` implementing `WifiRouterAdapter`; map the brand's response to `ConnectedWifiClient`.
   Never log or return `config.password`.
3. Register it in `src/adapters/index.ts` (`registry.<TYPE> = () => new BrandAdapter()`). It then appears in the UI's router-type list.
4. Add tests with recorded sample responses; keep them free of real credentials.

## Limits of "currently connected" polling
If the router only lists current clients, a device that connects and disconnects between two polls is missed.
Prefer a controller/API that offers history, DHCP/association logs or an event stream. The Routers page shows a warning for
adapters without history. Lower the polling interval (min 5 s) if the router can handle it.

## Demo mode (MOCK)
Put a comma-separated list of MAC addresses in a MOCK router's **API path** to simulate those clients being connected;
put `FAIL` to simulate an outage.
