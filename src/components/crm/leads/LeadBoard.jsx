// Admissions board (FLKRM-326 S1). Cards can be dragged between stages with a
// mouse, touch (press and hold) or keyboard (Space to pick up, arrows, Space to
// drop); the "Move to…" menu stays as the plain alternative. Columns a lead may
// not move to are dimmed and refuse the drop; the server re-checks every move.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';
import { Badge } from '../../ui/Badge';
import { cn } from '../../../lib/utils';
import { TagChips } from '../records/TagPicker';
import { MoveToSelect, StageBadge, formatDate, lostLabel, moveTargets, sinceLabel } from './leadUi';

export function OwnerLabel({ lead }) {
  if (lead.owner) return <span>{lead.owner.name}</span>;
  return <Badge variant="warning">Unowned</Badge>;
}

function CardBody({ lead, stages, canWrite, busy, onMove, overlay = false }) {
  const lost = lead.stage.category === 'lost' ? lostLabel(lead) : null;
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        {overlay
          ? <span className="font-medium text-foreground">{lead.learnerName}</span>
          : <Link to={`/crm/leads/${lead.id}`} className="font-medium text-foreground hover:underline">{lead.learnerName}</Link>}
        {lead.learnerGrade && <span className="shrink-0 text-xs text-muted-foreground">Gr {lead.learnerGrade}</span>}
      </div>
      {lead.interest.course && <p className="text-xs text-muted-foreground">{lead.interest.course}</p>}
      <TagChips tags={lead.tags} />
      {lost && <p className="text-xs text-destructive">{lost}</p>}
      {lead.convertedStudentId && !overlay && (
        <Link to={`/crm/students/${lead.convertedStudentId}`} className="text-xs text-accent hover:underline">Student profile →</Link>
      )}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <OwnerLabel lead={lead} />
        <span title={`Last activity ${formatDate(lead.lastActivityAt)}`}>{sinceLabel(lead.lastActivityAt)}</span>
      </div>
      {canWrite && !overlay && <MoveToSelect lead={lead} stages={stages} disabled={busy} onMove={onMove} />}
    </>
  );
}

const CARD = 'space-y-2 rounded-lg border border-border bg-card p-3 shadow-sm';

function LeadCard({ lead, stages, canWrite, busy, onMove }) {
  const draggable = canWrite && !busy && moveTargets(lead, stages).length > 0;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: lead.id, disabled: !draggable });
  return (
    <li
      ref={setNodeRef}
      {...(draggable ? { ...attributes, ...listeners } : {})}
      aria-roledescription={draggable ? 'Draggable lead' : undefined}
      aria-label={draggable ? `${lead.learnerName}, in ${lead.stage.name}` : undefined}
      className={cn(CARD, draggable && 'cursor-grab touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', isDragging && 'opacity-40')}
    >
      <CardBody lead={lead} stages={stages} canWrite={canWrite} busy={busy} onMove={onMove} />
    </li>
  );
}

function Column({ stage, leads, dropState, cardProps }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, disabled: dropState === 'blocked' });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${stage.name} stage`}
      className={cn(
        'flex w-64 shrink-0 flex-col rounded-xl border border-border bg-card/50 p-3 transition',
        dropState === 'allowed' && 'ring-2 ring-primary/30',
        dropState === 'allowed' && isOver && 'bg-primary/10 ring-primary',
        dropState === 'blocked' && 'opacity-50',
      )}
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-semibold">{stage.name}</h2>
        <StageBadge category={stage.category}>{leads.length}</StageBadge>
      </header>
      <ul className="min-h-12 space-y-2">
        {leads.map((lead) => <LeadCard key={lead.id} lead={lead} {...cardProps} />)}
      </ul>
      {!leads.length && <p className="py-4 text-center text-xs text-muted-foreground">No leads</p>}
    </section>
  );
}

export default function LeadBoard({ stages, leads, canWrite, busy, onMove }) {
  const [activeId, setActiveId] = useState(null);
  const sensors = useSensors(
    // A small move before dragging, so clicks on the name still open the lead.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Press and hold on touch, so swiping still scrolls the board.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const byStage = useMemo(() => {
    const map = new Map(stages.map((stage) => [stage.id, []]));
    for (const lead of leads) map.get(lead.stage.id)?.push(lead);
    return map;
  }, [stages, leads]);

  const active = activeId ? leads.find((lead) => lead.id === activeId) : null;
  const allowed = useMemo(() => new Set(active ? moveTargets(active, stages).map((stage) => stage.id) : []), [active, stages]);
  const dropState = (stage) => {
    if (!active) return null;
    if (stage.id === active.stage.id) return 'home';
    return allowed.has(stage.id) ? 'allowed' : 'blocked';
  };
  const stageName = (id) => stages.find((stage) => stage.id === id)?.name || 'this stage';
  const leadName = (id) => leads.find((lead) => lead.id === id)?.learnerName || 'Lead';

  const announcements = {
    onDragStart: ({ active: item }) => `Picked up ${leadName(item.id)}.`,
    onDragOver: ({ active: item, over }) => (over ? `${leadName(item.id)} is over ${stageName(over.id)}${allowed.has(over.id) ? '' : ', which is not allowed'}.` : undefined),
    onDragEnd: ({ active: item, over }) => (over && allowed.has(over.id) ? `Moving ${leadName(item.id)} to ${stageName(over.id)}.` : `${leadName(item.id)} was not moved.`),
    onDragCancel: ({ active: item }) => `Cancelled. ${leadName(item.id)} was not moved.`,
  };

  const handleDragEnd = ({ active: item, over }) => {
    const lead = leads.find((candidate) => candidate.id === item.id);
    setActiveId(null);
    if (!lead || !over || !allowed.has(over.id)) return;
    const stage = stages.find((candidate) => candidate.id === over.id);
    if (stage) onMove(lead, stage);
  };

  const cardProps = { stages, canWrite, busy, onMove };
  return (
    <DndContext
      sensors={sensors}
      accessibility={{ announcements, screenReaderInstructions: { draggable: 'Press Space to pick up the lead, use the arrow keys to choose a stage, then Space to drop or Escape to cancel.' } }}
      onDragStart={({ active: item }) => setActiveId(item.id)}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={handleDragEnd}
    >
      <div className="-mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
        <div className="flex gap-4" style={{ minWidth: `${stages.length * 17}rem` }}>
          {stages.map((stage) => (
            <Column key={stage.id} stage={stage} leads={byStage.get(stage.id) || []} dropState={dropState(stage)} cardProps={cardProps} />
          ))}
        </div>
      </div>
      {/* Rendered outside the scrolling board so the card isn't clipped while dragging. */}
      <DragOverlay>
        {active && <div className={cn(CARD, 'w-64 cursor-grabbing shadow-lg')}><CardBody lead={active} {...cardProps} overlay /></div>}
      </DragOverlay>
    </DndContext>
  );
}
