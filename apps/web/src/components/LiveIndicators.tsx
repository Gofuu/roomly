import { useSession } from '../lib/auth';
import { useRealtimeStatus } from '../lib/realtime';
import { cx } from './ui';

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

const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const COLORS = ['bg-sky-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-teal-500'];
const colorFor = (id: string) => COLORS[[...id].reduce((h, c) => h + c.charCodeAt(0), 0) % COLORS.length];

/** Avatars of the other people currently looking at the same calendar. */
export function Viewers({ viewers }: { viewers: { id: string; name: string }[] }) {
  const { user } = useSession();
  const others = viewers.filter((v) => v.id !== user.id);
  if (others.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-2">
        {others.slice(0, 4).map((v) => (
          <span
            key={v.id}
            title={v.name}
            className={cx('flex size-7 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ring-white', colorFor(v.id))}
          >
            {initials(v.name)}
          </span>
        ))}
      </div>
      <span className="text-xs text-slate-500">
        {others.length === 1 ? `${others[0]!.name} is` : `${others.length} others are`} viewing
      </span>
    </div>
  );
}
