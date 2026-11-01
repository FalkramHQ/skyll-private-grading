// One class session as a compact card (FLKRM-327 S3): time, batch, subject,
// instructor and room, with its state. Used by the week view, the batch's
// session list and the Overview.
import { Link } from 'react-router-dom';
import { ExternalLink, MapPin } from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { cn } from '../../../lib/utils';
import { formatTime } from '../../../lib/crm/classes';

export function SessionStatus({ session }) {
  if (session.status === 'cancelled') return <Badge variant="secondary">Cancelled</Badge>;
  if (session.status === 'held') return <Badge variant="success">Attendance taken</Badge>;
  if (session.notMarked) return <Badge variant="warning">Not marked</Badge>;
  return null;
}

export default function SessionCard({ session, timezone, showBatch = true, onOpen, className }) {
  const cancelled = session.status === 'cancelled';
  const body = (
    <>
      <div className="flex items-center gap-2">
        <span className={cn('font-semibold tabular-nums', cancelled && 'line-through')}>
          {formatTime(session.startsAt, timezone)}–{formatTime(session.endsAt, timezone)}
        </span>
        {session.isMine && <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">You</span>}
      </div>
      {showBatch && <p className={cn('font-medium', cancelled && 'line-through')}>{session.batch.name}</p>}
      <p className="text-muted-foreground">
        {[session.subject?.name, session.instructor.name].filter(Boolean).join(' · ')}
      </p>
      {(session.room || session.onlineUrl) && (
        <p className="flex items-center gap-1 text-muted-foreground">
          {session.room ? <><MapPin className="h-3 w-3" aria-hidden="true" />{session.room.name}</> : <><ExternalLink className="h-3 w-3" aria-hidden="true" />Online</>}
        </p>
      )}
      <div className="flex flex-wrap gap-1 pt-0.5">
        <SessionStatus session={session} />
        {session.isEdited && <Badge variant="outline">Changed</Badge>}
        {session.onLeave && <Badge variant="warning">Instructor on leave</Badge>}
      </div>
      {cancelled && session.cancelReason && <p className="text-muted-foreground">{session.cancelReason}</p>}
    </>
  );
  const classes = cn(
    'block w-full space-y-0.5 rounded-lg border border-border bg-card p-2 text-left text-xs transition-colors',
    cancelled && 'bg-muted/50 opacity-80',
    session.isMine && !cancelled && 'border-accent/50',
    (onOpen || session.href) && 'hover:bg-muted',
    className,
  );
  if (onOpen) return <button type="button" className={classes} onClick={() => onOpen(session)}>{body}</button>;
  if (session.href) return <Link to={session.href} className={classes}>{body}</Link>;
  return <div className={classes}>{body}</div>;
}
