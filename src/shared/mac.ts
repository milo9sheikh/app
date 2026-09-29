/** Canonical MAC format: AA:BB:CC:DD:EE:FF. Returns null if the input is not a valid 48-bit MAC. */
export function normalizeMac(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const hex = input.trim().replace(/[:\-.\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex)) return null;
  return hex.match(/.{2}/g)!.join(':');
}

/** True when the locally-administered bit is set, which is typical of private/randomized WiFi addresses. */
export function isLocallyAdministeredMac(mac: string): boolean {
  const first = parseInt(mac.slice(0, 2), 16);
  return (first & 0x02) !== 0;
}

export function maskMac(mac: string): string {
  return mac.slice(0, 8) + ':••:••:••';
}
