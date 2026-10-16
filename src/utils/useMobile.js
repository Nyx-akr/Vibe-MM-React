import React from 'react';

/** Below this width the main page switches to its phone layout. */
export const MOBILE_MAX_PX = 760;

const query = () => (typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(max-width: ' + MOBILE_MAX_PX + 'px)')
  : null);

/** True on a phone-sized screen; follows rotation and window resizes. */
export function useMobile() {
  const [mobile, setMobile] = React.useState(() => Boolean(query() && query().matches));
  React.useEffect(() => {
    const mq = query();
    if (!mq) return undefined;
    const on = () => setMobile(mq.matches);
    on();
    if (mq.addEventListener) mq.addEventListener('change', on); else mq.addListener(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on); };
  }, []);
  return mobile;
}
