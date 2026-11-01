// Public admissions inquiry form at /inquire/:schoolSlug (CRM-009, FLKRM-326
// S6, D8). No login. The school comes only from the link; the server decides
// whether the form is open. Validation uses the same zod schema as the server.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { display } from '../components/marketing/Notebook';
import { cn } from '../lib/utils';
import { Skeleton } from '../components/ui/Skeleton';
import { crmFetch } from '../lib/crm/api';
import { inquiryBody } from '../../shared/crm/inquiry.js';
import { fieldErrors } from '../../shared/crm/leads.js';

const EMPTY = {
  parentName: '', parentPhone: '', learnerName: '', learnerGrade: '', course: '', schedule: '', message: '',
  consent: false, whatsappOptIn: false, website: '',
};

// Never sent with a platform-staff school choice: this page is public.
const publicFetch = (path, options = {}) => crmFetch(path, { ...options, schoolId: '' });

// Loud volume: parents open this from a link, often on a phone.
const inputClass = 'h-12 border-[1.5px] border-ink text-[15px] hover:border-ink aria-invalid:border-destructive aria-invalid:bg-destructive-soft';
const checkboxClass = 'mt-0.5 h-5 w-5 shrink-0 accent-action';

function Field({ id, label, hint, error, children }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[14px] font-semibold text-ink">{label}</label>
      {children}
      {hint && !error && <p className="text-[13px] text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-[13px] font-semibold text-destructive">{error}</p>}
    </div>
  );
}

function toBody(values) {
  const body = { parentName: values.parentName, parentPhone: values.parentPhone, learnerName: values.learnerName, consent: values.consent };
  for (const key of ['learnerGrade', 'course', 'schedule', 'message', 'website']) {
    if (values[key].trim()) body[key] = values[key];
  }
  if (values.whatsappOptIn) body.whatsappOptIn = true;
  return body;
}

export default function PublicInquiry() {
  const { schoolSlug } = useParams();
  const query = new URLSearchParams({ school: schoolSlug || '' }).toString();
  const [status, setStatus] = useState('loading');
  const [school, setSchool] = useState(null);
  const [values, setValues] = useState(EMPTY);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    publicFetch(`public/inquiry?${query}`)
      .then((data) => { if (active) { setSchool(data.school); setStatus('ready'); } })
      .catch((err) => { if (active) setStatus(err.status === 404 ? 'unavailable' : 'error'); });
    return () => { active = false; };
  }, [query]);

  useEffect(() => {
    document.title = school ? `Admissions inquiry · ${school.name}` : 'Admissions inquiry';
  }, [school]);

  const body = toBody(values);
  const errors = touched ? fieldErrors(inquiryBody.safeParse(body)) : {};
  const set = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setValues((current) => ({ ...current, [key]: value }));
  };
  const invalid = (key) => (errors[key] ? { 'aria-invalid': true, 'aria-describedby': `${key}-error` } : {});

  const submit = async (event) => {
    event.preventDefault();
    setTouched(true);
    if (!inquiryBody.safeParse(body).success) return;
    setBusy(true);
    setError(null);
    try {
      await publicFetch(`public/inquiry?${query}`, { method: 'POST', body });
      setStatus('sent');
    } catch (err) {
      if (err.status === 404) setStatus('unavailable');
      else setError(err.status === 429 ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="notebook-grid min-h-screen px-4 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-xl">
        {status === 'loading' && <Skeleton className="h-96 w-full" />}
        {status === 'unavailable' && (
          <Card loud>
            <CardHeader>
              <CardTitle className="text-[26px]">This form isn&apos;t available</CardTitle>
              <CardDescription>The link may be wrong, or the school isn&apos;t taking inquiries online right now. Please contact the school directly.</CardDescription>
            </CardHeader>
          </Card>
        )}
        {status === 'error' && (
          <Alert variant="destructive"><AlertDescription>We couldn&apos;t load this form. Please refresh the page.</AlertDescription></Alert>
        )}
        {status === 'sent' && (
          <Card loud>
            <CardHeader className="items-start gap-2 p-7 sm:p-8">
              <span className="mb-2 flex h-14 w-14 rotate-[-4deg] items-center justify-center rounded-full border-2 border-ink bg-lime" aria-hidden="true">
                <Check className="h-7 w-7 text-ink" strokeWidth={2.8} />
              </span>
              <h1 className={cn(display, 'text-[40px] text-ink')}>Thank you</h1>
              <CardDescription className="text-[16px] leading-relaxed text-foreground-secondary">{school.name} has your inquiry and will contact you soon.</CardDescription>
            </CardHeader>
          </Card>
        )}
        {status === 'ready' && (
          <Card loud>
            <CardHeader className="gap-1 p-6 sm:p-8">
              <p className="text-[13px] font-bold uppercase tracking-[0.12em] text-foreground-secondary">{school.name}</p>
              <h1 className={cn(display, 'pt-1 text-[36px] text-ink sm:text-[44px]')}>Admissions inquiry</h1>
              <CardDescription className="pt-1 text-[16px] leading-relaxed text-foreground-secondary">Tell us about your child and the school will get in touch.</CardDescription>
            </CardHeader>
            <CardContent className="p-6 pt-0 sm:p-8 sm:pt-0">
              <form className="space-y-5" onSubmit={submit} noValidate>
                <Field id="parentName" label="Your name" error={errors.parentName}>
                  <Input className={inputClass} id="parentName" autoComplete="name" maxLength={120} value={values.parentName} onChange={set('parentName')} {...invalid('parentName')} />
                </Field>
                <Field id="parentPhone" label="Your phone number" hint="The school will call or message you on this number." error={errors.parentPhone}>
                  <Input className={inputClass} id="parentPhone" type="tel" inputMode="tel" autoComplete="tel" maxLength={24} value={values.parentPhone} onChange={set('parentPhone')} {...invalid('parentPhone')} />
                </Field>
                <Field id="learnerName" label="Student’s name" error={errors.learnerName}>
                  <Input className={inputClass} id="learnerName" maxLength={120} value={values.learnerName} onChange={set('learnerName')} {...invalid('learnerName')} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="learnerGrade" label="Grade (optional)">
                    <Input className={inputClass} id="learnerGrade" maxLength={32} value={values.learnerGrade} onChange={set('learnerGrade')} />
                  </Field>
                  <Field id="schedule" label="Preferred timing (optional)">
                    <Input className={inputClass} id="schedule" maxLength={120} placeholder="e.g. Weekends" value={values.schedule} onChange={set('schedule')} />
                  </Field>
                </div>
                <Field id="course" label="Course or subject (optional)">
                  <Input className={inputClass} id="course" maxLength={120} value={values.course} onChange={set('course')} />
                </Field>
                <Field id="message" label="Anything else? (optional)" error={errors.message}>
                  <textarea
                    id="message"
                    rows={3}
                    maxLength={1000}
                    value={values.message}
                    onChange={set('message')}
                    className="flex w-full rounded-[10px] border-[1.5px] border-ink bg-card px-3 py-2.5 text-[15px] text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                </Field>
                {/* Hidden from people; bots that fill it are ignored. */}
                <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
                  <label htmlFor="website">Website</label>
                  <input id="website" tabIndex={-1} autoComplete="off" value={values.website} onChange={set('website')} />
                </div>
                <div className="space-y-2">
                  <label className="flex cursor-pointer items-start gap-3 text-[15px] leading-snug text-ink">
                    <input type="checkbox" className={checkboxClass} checked={values.consent} onChange={set('consent')} {...invalid('consent')} />
                    <span>I agree that {school.name} may contact me about admissions and keep these details for that purpose.</span>
                  </label>
                  {errors.consent && <p id="consent-error" className="text-xs text-destructive">{errors.consent}</p>}
                  <label className="flex cursor-pointer items-start gap-3 text-[15px] leading-snug text-ink">
                    <input type="checkbox" className={checkboxClass} checked={values.whatsappOptIn} onChange={set('whatsappOptIn')} />
                    <span>Send me WhatsApp updates about my child’s classes, fees and progress (optional). Reply STOP at any time to stop them.</span>
                  </label>
                </div>
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <Button type="submit" className="h-12 w-full rounded-xl border-2 text-base font-bold shadow-hard-md" disabled={busy}>{busy ? 'Sending…' : 'Send inquiry'}</Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
