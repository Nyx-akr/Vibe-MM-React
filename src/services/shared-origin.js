/**
 * Where the raw store is when this page was not opened on the collector's
 * machine - i.e. when someone else is looking at a shared link.
 *
 * The app normally chooses between a local store and a deployed one, a
 * preference kept per browser in localStorage. That choice cannot work for a
 * visitor: 'local' means *their* machine, and nobody is going to be told to
 * open the admin panel and flip a switch before the dashboard will load.
 *
 * When the collector serves the dashboard itself (see Vibe-mm-server/lib/
 * share.js), the answer is simply the origin the page came from. This module
 * says when that is the case, and api.js verifies it by probing for our own
 * manifest before trusting it - so an app served from anywhere that is NOT
 * also serving the raw store (Vercel, a plain static host) falls straight
 * back to the usual local/deployed logic.
 *
 * Nothing else imports this, and removing it changes only shared access.
 */

/** Hostnames that mean "the machine this browser is running on". */
const OWN_MACHINE = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);

/**
 * The origin this page was served from, when that could plausibly be the
 * collector, or null when the usual target logic should decide.
 *
 * A LAN address counts: opening the dashboard from a phone at
 * http://192.168.1.20:8787 is the same situation as a tunnel, and the same
 * answer is right.
 */
export function sharedOrigin() {
  if (typeof window === 'undefined' || !window.location) return null;
  const { protocol, hostname, origin } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  if (OWN_MACHINE.has(String(hostname || '').toLowerCase())) return null;
  if (hostname.endsWith('.localhost')) return null;
  return origin.replace(/\/+$/, '');
}

/** True when this page is somebody's view of a shared link. */
export const isSharedView = () => sharedOrigin() !== null;
