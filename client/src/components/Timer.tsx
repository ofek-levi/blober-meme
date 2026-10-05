import type { ReactElement } from 'react';

const URGENT_AT_SECONDS = 10;

export function Timer({
  secondsLeft,
  totalSeconds,
  label,
}: {
  secondsLeft: number | null;
  totalSeconds: number;
  label?: string;
}): ReactElement {
  const urgent = secondsLeft !== null && secondsLeft <= URGENT_AT_SECONDS;
  const remaining =
    secondsLeft === null || totalSeconds <= 0
      ? 0
      : Math.max(0, Math.min(100, (secondsLeft / totalSeconds) * 100));

  return (
    <div className={urgent ? 'timer timer--urgent' : 'timer'}>
      {label !== undefined && label !== '' && <div className="label">{label}</div>}
      <div className="timer-time">{formatClock(secondsLeft)}</div>
      <div className="timer-bar">
        <div className="timer-bar-fill" style={{ width: `${remaining}%` }} />
      </div>
    </div>
  );
}

function formatClock(secondsLeft: number | null): string {
  if (secondsLeft === null) return '--';
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
