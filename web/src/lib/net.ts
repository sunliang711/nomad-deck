/**
 * Checks whether an address or hostname is a loopback address unsuitable for multi-node cluster communication.
 */
export function isLoopbackAddress(addr: string): boolean {
  const v = addr.trim().toLowerCase();
  return v === '127.0.0.1' || v === 'localhost' || v === '::1' || v === '[::1]';
}
