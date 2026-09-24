import { cx } from './ui';

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cx('flex w-fit items-center gap-2', className)}>
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-indigo-600" />
        <rect x="8" y="9" width="16" height="14" rx="2" fill="none" stroke="white" strokeWidth="2" />
        <path d="M8 14h16M13 9v-2M19 9v-2" stroke="white" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="text-lg font-semibold tracking-tight text-slate-900">Roomly</span>
    </div>
  );
}
