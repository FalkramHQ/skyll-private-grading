// Course and batch forms for the Classes section (FLKRM-327 S1). Both validate
// with the server's own zod schemas before submitting.
import { useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { classesWrite, numberOrNull, textOrNull } from '../../../lib/crm/classes';
import {
  DELIVERY_MODES, DELIVERY_MODE_LABELS, DURATION_UNITS, DURATION_UNIT_LABELS, addDuration, batchBody, courseBody, updateBatchBody, updateCourseBody,
} from '../../../../shared/crm/classes.js';
import { fieldErrors } from '../../../../shared/crm/leads.js';
import { Field, Textarea } from '../leads/leadUi';

export function FormFooter({ busy, onCancel, submitLabel, disabled }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button type="submit" disabled={busy || disabled}>{submitLabel}</Button>
    </div>
  );
}

function errorMessage(error) {
  if (!error) return null;
  if (error.code === 'version_conflict') return 'Someone else changed this meanwhile. Close and reopen to see the latest version.';
  return error.message;
}

function courseForm(course) {
  return {
    name: course?.name || '',
    program: course?.program || '',
    subjectId: course?.subject?.id || '',
    level: course?.level || '',
    durationValue: course?.duration?.value ? String(course.duration.value) : '',
    durationUnit: course?.duration?.unit || 'months',
    deliveryMode: course?.deliveryMode || 'classroom',
    academicYearId: course?.academicYear?.id || '',
    description: course?.description || '',
  };
}

/** New or edit course. `course` set = edit. */
export function CourseDialog({ open, onOpenChange, course, options, onSaved }) {
  const [form, setForm] = useState(() => courseForm(course));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm(courseForm(course));
    setTouched(false);
    setError(null);
  }, [open, course]);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const durationValue = numberOrNull(form.durationValue);
  const body = {
    name: form.name.trim(),
    program: form.program.trim() || undefined,
    subjectId: textOrNull(form.subjectId),
    level: form.level.trim() || undefined,
    durationValue,
    durationUnit: durationValue ? form.durationUnit : null,
    deliveryMode: form.deliveryMode,
    academicYearId: textOrNull(form.academicYearId),
    description: form.description.trim() || undefined,
    ...(course ? { courseId: course.id, expectedVersion: course.version } : {}),
  };
  const parsed = (course ? updateCourseBody : courseBody).safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};

  const submit = async (event) => {
    event.preventDefault();
    setTouched(true);
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await classesWrite(course ? 'classes/courses/update' : 'classes/courses', body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{course ? 'Edit course' : 'New course'}</DialogTitle>
          <DialogDescription>What the institute offers. Batches are the classes that run it.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <Field label="Course name" htmlFor="course-name" error={errors.name}>
            <Input id="course-name" maxLength={120} value={form.name} onChange={set('name')} autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Program (optional)" htmlFor="course-program" hint="A group such as JEE or Foundation">
              <Input id="course-program" list="course-programs" maxLength={60} value={form.program} onChange={set('program')} />
            </Field>
            <datalist id="course-programs">{(options?.programs || []).map((program) => <option key={program} value={program} />)}</datalist>
            <Field label="Subject (optional)" htmlFor="course-subject" hint="Leave blank for multi-subject courses">
              <Select id="course-subject" value={form.subjectId} onChange={set('subjectId')}>
                <option value="">No single subject</option>
                {(options?.subjects || []).map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
              </Select>
            </Field>
            <Field label="Level or grade (optional)" htmlFor="course-level">
              <Input id="course-level" maxLength={40} placeholder="Grade 10, A2…" value={form.level} onChange={set('level')} />
            </Field>
            <Field label="Delivery" htmlFor="course-mode">
              <Select id="course-mode" value={form.deliveryMode} onChange={set('deliveryMode')}>
                {DELIVERY_MODES.map((mode) => <option key={mode} value={mode}>{DELIVERY_MODE_LABELS[mode]}</option>)}
              </Select>
            </Field>
            <Field label="Duration (optional)" htmlFor="course-duration" error={errors.durationValue}>
              <div className="flex gap-2">
                <Input id="course-duration" type="number" min={1} max={520} inputMode="numeric" className="w-24" value={form.durationValue} onChange={set('durationValue')} />
                <Select aria-label="Duration unit" value={form.durationUnit} onChange={set('durationUnit')}>
                  {DURATION_UNITS.map((unit) => <option key={unit} value={unit}>{DURATION_UNIT_LABELS[unit]}</option>)}
                </Select>
              </div>
            </Field>
            <Field label="Academic year (optional)" htmlFor="course-year">
              <Select id="course-year" value={form.academicYearId} onChange={set('academicYearId')}>
                <option value="">Any year</option>
                {(options?.academicYears || []).map((year) => <option key={year.id} value={year.id}>{year.label}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Description (optional)" htmlFor="course-description">
            <Textarea id="course-description" maxLength={500} value={form.description} onChange={set('description')} />
          </Field>
          <p className="text-xs text-muted-foreground">Fees: set up later.</p>
          {error && <Alert variant="destructive"><AlertDescription>{errorMessage(error)}</AlertDescription></Alert>}
          <FormFooter busy={busy} onCancel={() => onOpenChange(false)} submitLabel={course ? 'Save course' : 'Create course'} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function batchForm(batch, presetCourseId, options) {
  const currentYear = options?.academicYears?.find((year) => year.isCurrent) || options?.academicYears?.[0];
  return {
    name: batch?.name || '',
    courseId: batch?.course?.id || presetCourseId || '',
    academicYearId: batch?.academicYear?.id || currentYear?.id || '',
    grade: batch?.grade || '',
    subjectId: batch?.subject?.id || '',
    startsOn: batch?.startsOn || '',
    endsOn: batch?.endsOn || '',
    capacity: batch?.capacity ? String(batch.capacity) : '',
    defaultRoomId: batch?.defaultRoom?.id || '',
    defaultOnlineUrl: batch?.defaultOnlineUrl || '',
  };
}

/** Fills blanks from a course: subject, class, year, and end date from its duration. */
function applyCourse(form, course) {
  if (!course) return form;
  const next = { ...form, courseId: course.id };
  if (!next.subjectId && course.subjectId) next.subjectId = course.subjectId;
  // Only a school class ("Grade 10", "10th") becomes the batch's class; levels like "CEFR A2" don't.
  const classMatch = /^(?:grade|class|std\.?)?\s*(\d{1,2})(?:st|nd|rd|th)?$/i.exec(course.level?.trim() || '');
  if (!next.grade && classMatch) next.grade = classMatch[1];
  if (course.academicYearId) next.academicYearId = course.academicYearId;
  if (!next.endsOn && next.startsOn && course.duration) next.endsOn = addDuration(next.startsOn, course.duration.value, course.duration.unit);
  return next;
}

/**
 * New or edit batch. `batch` set = edit. `presetCourseId` (from a course's
 * "New batch") fixes the course: it is shown as text, not a dropdown, so it
 * can't be changed by accident.
 */
export function BatchDialog({ open, onOpenChange, batch, presetCourseId, options, onSaved }) {
  const lockedCourse = !batch && presetCourseId ? options?.courses?.find((course) => course.id === presetCourseId) || { id: presetCourseId, name: 'this course' } : null;
  const [form, setForm] = useState(() => batchForm(batch, presetCourseId, options));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const courses = useMemo(() => {
    const list = options?.courses || [];
    // An archived course already on the batch stays selectable.
    return batch?.course && !list.some((course) => course.id === batch.course.id) ? [{ id: batch.course.id, name: `${batch.course.name} (archived)` }, ...list] : list;
  }, [options, batch]);
  const rooms = useMemo(() => {
    const list = options?.rooms || [];
    return batch?.defaultRoom && !list.some((room) => room.id === batch.defaultRoom.id) ? [{ ...batch.defaultRoom, name: `${batch.defaultRoom.name} (archived)` }, ...list] : list;
  }, [options, batch]);

  useEffect(() => {
    if (!open) return;
    const initial = batchForm(batch, presetCourseId, options);
    setForm(batch ? initial : applyCourse(initial, options?.courses?.find((course) => course.id === initial.courseId)));
    setTouched(false);
    setError(null);
  }, [open, batch, presetCourseId, options]);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const chooseCourse = (event) => {
    const courseId = event.target.value;
    setForm((current) => (courseId ? applyCourse({ ...current, courseId }, options?.courses?.find((course) => course.id === courseId)) : { ...current, courseId: '' }));
  };
  const chooseStart = (event) => {
    const startsOn = event.target.value;
    setForm((current) => {
      const course = options?.courses?.find((item) => item.id === current.courseId);
      const endsOn = !current.endsOn && course?.duration ? addDuration(startsOn, course.duration.value, course.duration.unit) : current.endsOn;
      return { ...current, startsOn, endsOn };
    });
  };

  const body = {
    name: form.name.trim(),
    courseId: lockedCourse ? lockedCourse.id : textOrNull(form.courseId),
    academicYearId: form.academicYearId,
    grade: form.grade.trim() || undefined,
    subjectId: textOrNull(form.subjectId),
    startsOn: textOrNull(form.startsOn),
    endsOn: textOrNull(form.endsOn),
    capacity: numberOrNull(form.capacity),
    defaultRoomId: textOrNull(form.defaultRoomId),
    defaultOnlineUrl: textOrNull(form.defaultOnlineUrl),
    ...(batch ? { batchId: batch.id, expectedVersion: batch.version } : {}),
  };
  const parsed = (batch ? updateBatchBody : batchBody).safeParse(body);
  const errors = touched ? fieldErrors(parsed) : {};

  const submit = async (event) => {
    event.preventDefault();
    setTouched(true);
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await classesWrite(batch ? 'classes/batches/update' : 'classes/batches', body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{batch ? 'Edit batch' : lockedCourse ? `New batch for ${lockedCourse.name}` : 'New batch'}</DialogTitle>
          <DialogDescription>
            {batch ? 'Changes apply everywhere this batch is used, including tests.' : 'A class group of students. It is also available when creating tests.'}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <Field label="Batch name" htmlFor="batch-name" error={errors.name}>
            <Input id="batch-name" maxLength={120} placeholder="Grade 10 Maths Evening" value={form.name} onChange={set('name')} autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {lockedCourse
              ? (
                <Field label="Course" htmlFor="batch-course-fixed">
                  <p id="batch-course-fixed" className="flex h-10 items-center rounded-lg border border-input bg-muted px-3 text-sm">{lockedCourse.name}</p>
                </Field>
              )
              : (
                <Field label="Course (optional)" htmlFor="batch-course">
                  <Select id="batch-course" value={form.courseId} onChange={chooseCourse}>
                    <option value="">No course</option>
                    {courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
                  </Select>
                </Field>
              )}
            <Field label="Academic year" htmlFor="batch-year" error={errors.academicYearId}>
              <Select id="batch-year" value={form.academicYearId} onChange={set('academicYearId')}>
                <option value="">Choose a year</option>
                {(options?.academicYears || []).map((year) => <option key={year.id} value={year.id}>{year.label}</option>)}
              </Select>
            </Field>
            <Field label="Class (optional)" htmlFor="batch-grade" hint="Used for new students' enrollment">
              <Input id="batch-grade" maxLength={40} placeholder="10" value={form.grade} onChange={set('grade')} />
            </Field>
            <Field label="Subject (optional)" htmlFor="batch-subject">
              <Select id="batch-subject" value={form.subjectId} onChange={set('subjectId')}>
                <option value="">No single subject</option>
                {(options?.subjects || []).map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
              </Select>
            </Field>
            <Field label="Starts on (optional)" htmlFor="batch-starts" error={errors.startsOn}>
              <Input id="batch-starts" type="date" value={form.startsOn} onChange={chooseStart} />
            </Field>
            <Field label="Ends on (optional)" htmlFor="batch-ends" error={errors.endsOn}>
              <Input id="batch-ends" type="date" value={form.endsOn} onChange={set('endsOn')} />
            </Field>
            <Field label="Capacity (optional)" htmlFor="batch-capacity" error={errors.capacity} hint="A warning only; nobody is turned away">
              <Input id="batch-capacity" type="number" min={1} max={1000} inputMode="numeric" value={form.capacity} onChange={set('capacity')} />
            </Field>
            <Field label="Usual room (optional)" htmlFor="batch-room">
              <Select id="batch-room" value={form.defaultRoomId} onChange={set('defaultRoomId')}>
                <option value="">No usual room</option>
                {rooms.map((room) => <option key={room.id} value={room.id}>{room.seats ? `${room.name} · ${room.seats} seats` : room.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Online class link (optional)" htmlFor="batch-link" error={errors.defaultOnlineUrl}>
            <Input id="batch-link" type="url" maxLength={500} placeholder="https://" value={form.defaultOnlineUrl} onChange={set('defaultOnlineUrl')} />
          </Field>
          {error && <Alert variant="destructive"><AlertDescription>{errorMessage(error)}</AlertDescription></Alert>}
          <FormFooter busy={busy} onCancel={() => onOpenChange(false)} submitLabel={batch ? 'Save batch' : 'Create batch'} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
