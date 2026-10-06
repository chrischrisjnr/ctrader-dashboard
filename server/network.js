import os from 'node:os';

/** Addresses other devices can use to open the dashboard (only when it listens on all interfaces). */
export function networkUrls(host, port) {
  if (host !== '0.0.0.0' && host !== '::') return [];
  const urls = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const a of addresses || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [first, second] = a.address.split('.').map(Number);
      // 100.64.0.0/10 is what Tailscale uses; it works from anywhere, not just home Wi-Fi.
      const tailscale = first === 100 && second >= 64 && second <= 127;
      urls.push({ url: `http://${a.address}:${port}`, kind: tailscale ? 'tailscale' : 'wifi', name });
    }
  }
  return urls.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'wifi' ? -1 : 1));
}
