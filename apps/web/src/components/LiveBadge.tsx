import { useRealtimeStatus } from '../lib/realtime';
import { cx } from './ui';

/** Small pill showing whether live updates are connected. */
export function LiveBadge() {
  const status = useRealtimeStatus();
  const label = { live: 'Live', connecting: 'Reconnecting…', offline: 'Offline' }[status];
  return (
    <span
      className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1',
        status === 'live' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-amber-50 text-amber-700 ring-amber-200')}
      title={status === 'live' ? 'Changes by others appear instantly' : 'Live updates paused'}
    >
      <span className={cx('size-1.5 rounded-full', status === 'live' ? 'animate-pulse bg-emerald-500' : 'bg-amber-500')} />
      {label}
    </span>
  );
}
