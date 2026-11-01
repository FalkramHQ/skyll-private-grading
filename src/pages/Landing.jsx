import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  Code,
  FileText,
  GitBranch,
  Lightbulb,
  Lock,
  Mail,
  MessageCircle,
  Palette,
  Plus,
  ScanLine,
  ShieldCheck,
  Users,
} from 'lucide-react';
import Header from '../components/Header';
import Footer from '../components/Footer';
import { Button } from '../components/ui/Button';
import { Sticker } from '../components/ui/Sticker';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Eyebrow, Highlight, SectionHeading, Tape, display, heading, loudPrimary, loudSecondary } from '../components/marketing/Notebook';
import { cn } from '../lib/utils';
import aiLabsImage from '../assets/ai-labs.webp';
import partnerdLogo from '../assets/logo-partnerd.webp';
import partnerAcademyCLogo from '../assets/logo-partner-academy-c.webp';
import partnerAcademyBLogo from '../assets/logo-partner-academy-bs.webp';
import partneraAcademyLogo from '../assets/logo-partnera.webp';
import partnerfLogo from '../assets/logo-partnerf.webp';

// Production figures as of 2026-10-10 (submissions.graded_at, submission_questions_v2).
// Round down; refresh when they move.
export const PROOF = {
  papers: '1,100+',
  questions: '25,000+',
  institutes: '6',
  cities: 'Mumbai, Hyderabad and Bangalore',
  cityCount: '3',
};

// Optional. Set VITE_WHATSAPP_NUMBER (digits only, with country code) to show
// a WhatsApp button next to the email in the closing call to action.
const WHATSAPP_NUMBER = (import.meta.env.VITE_WHATSAPP_NUMBER || '').replace(/\D/g, '');
const CONTACT_EMAIL = 'office@skyllai.com';

const INSTITUTES = [
  { src: partnerAcademyBLogo, alt: "Partner Academy B", className: 'h-12 sm:h-14' },
  { src: partnerAcademyCLogo, alt: 'Partner Academy C', className: 'h-8 sm:h-10' },
  { src: partneraAcademyLogo, alt: "Partner Academy A", className: 'h-9 sm:h-11' },
  { src: partnerdLogo, alt: 'Partner Academy D', className: 'h-12 sm:h-14' },
  { src: partnerfLogo, alt: 'Partner Academy F', className: 'h-12 sm:h-14' },
];

const STEPS = [
  {
    icon: FileText,
    title: 'You run exams as usual',
    body: 'Same paper, same hall, same teachers. Nothing about how you examine changes.',
  },
  {
    icon: ScanLine,
    title: 'You scan on campus',
    body: 'Your admin staff or teachers scan each answer sheet with the Skyll app on a phone. The paper never leaves your building.',
  },
  {
    icon: ClipboardCheck,
    title: 'Marked, checked, reported',
    body: 'Our AI marks each answer and Skyll’s reviewers check the marking. Reports for students, parents and teachers arrive within 24 hours. Your teachers don’t mark or review anything.',
  },
];

const AUDIENCES = [
  { icon: Users, title: 'Teachers', body: 'Graded papers, the gaps across the class, and a plan for the next lesson.', tile: 'bg-lime' },
  { icon: FileText, title: 'Students', body: 'A personal report with what went well, what to revise, and how.', tile: 'bg-coral' },
  { icon: BarChart3, title: 'Parents', body: 'Mastery per topic with an honest confidence range, not a single number.', tile: 'bg-action-tint' },
  { icon: Lightbulb, title: 'Owners and principals', body: 'Analytics across every batch and subject, from one exam onwards.', tile: 'bg-sunken' },
];

const TESTIMONIALS = [
  { quote: 'Simple to use. More importantly, genuinely useful for our teachers.', author: "Partner Academy A" },
  { quote: 'The transition was effortless because nothing about our exam process had to change.', author: "Partner Academy B" },
  { quote: 'Skyll helped us understand learning, not just measure it.', author: 'Partner Academy C' },
  { quote: "We started noticing patterns we simply couldn't see before.", author: 'Partner Academy D' },
];

const TRUST = [
  { icon: CheckCircle2, title: 'Our reviewers check every answer', body: 'Nothing reaches a student or parent until a Skyll reviewer has checked the AI’s marking. Every decision is recorded.' },
  { icon: GitBranch, title: 'The evidence gate', body: 'We only estimate what a student knows when there is measured, curriculum-tagged evidence for it. No evidence, no estimate.' },
  { icon: Lock, title: 'Paper stays on your campus', body: 'Answer sheets are scanned in your building with the Skyll app. The scans are processed on Skyll’s servers under our privacy notice, and are deleted on request.' },
  { icon: ShieldCheck, title: 'Built in line with the DPDP Act 2023', body: 'A published compliance statement, a named grievance officer, and account and data deletion on request.' },
];

const FAQ = [
  { q: 'Does it work with messy handwriting?', a: 'Yes. The OCR is built for handwritten Indian exam scripts, and anything it is unsure about is held for a Skyll reviewer to check rather than guessed. Very faint or illegible pages are flagged, not silently skipped.' },
  { q: 'Which subjects, boards and languages?', a: 'Maths, Science and language papers for CBSE, state boards and competitive-exam coaching, plus writing tasks from English-proficiency mock tests. English and Hindi scripts today; other languages on request.' },
  { q: 'How long does it take?', a: 'Marked sheets and reports arrive within 24 hours of scanning. Very large exams can take a little longer, and you can watch progress in your dashboard.' },
  { q: 'Is our data safe?', a: 'Your scans and results are stored on Skyll’s servers under our DPDP Act compliance statement, with a named grievance officer and deletion on request. Your institute’s data is never used for another institute, and the paper itself never leaves your campus.' },
  { q: 'What does it cost?', a: 'The trial is free: 30 answer sheets, marked with reports in 24 hours. After that you pay a price per student (monthly for coaching and language institutes, yearly for schools) with reports included. No setup fee and no annual contract. Email us and we’ll send the price for your institute.' },
  { q: 'What do teachers have to do?', a: 'Nothing beyond scanning. Your staff scan the answer sheets with the Skyll app; our AI marks them and Skyll’s reviewers check the marking. Your teachers get finished results and reports, and the hours they spent marking back.' },
];

const DEMOS = [
  { to: '/demo', title: 'Teacher dashboard', body: 'Class averages, learning gaps, exam hotspots and a recommended action plan.' },
  { to: '/demo/report/aarav9tu', title: 'Student report', body: 'What one student got right, where they slipped, and what to revise next.' },
  { to: '/learner-dna', title: 'Mastery with confidence', body: 'How a topic score like 72% (64–80%) is built from curriculum-tagged evidence.' },
];

const linkFocus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

// The hero's product card: sample data from the public demo class, drawn as a
// loud report card with tape and a sticker rather than a soft screenshot.
function HeroPreview() {
  const stats = [['Students', '10'], ['Average', '64%'], ['Pass rate', '90%'], ['Top score', '19/20']];
  const gaps = [
    { topic: 'Polynomials', pct: 45 },
    { topic: 'Decimal representation', pct: 48 },
    { topic: 'Linear equations', pct: 57 },
  ];
  return (
    <div className="relative mx-auto w-full max-w-[520px] pt-4 sm:pb-40" aria-hidden="true">
      <div className="relative rounded-[20px] border-2 border-ink bg-card shadow-hard-lg lg:-rotate-2">
        <Tape className="-top-4 left-1/2 -ml-12" tilt={-4} />
        <div className="flex items-start justify-between gap-3 px-5 pt-6 sm:px-6">
          <div className="min-w-0">
            <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-foreground-secondary">Teacher dashboard</p>
            <p className="mt-1 font-display text-[21px] font-extrabold leading-tight tracking-[-0.03em] text-ink sm:text-[24px]">Mid-term · 9A · Maths</p>
          </div>
          <StatusBadge status="positive" className="mt-0.5 shrink-0">Reviewed</StatusBadge>
        </div>
        <div className="mt-5 grid grid-cols-4 border-y-2 border-ink">
          {stats.map(([k, v], i) => (
            <div key={k} className={cn('px-2.5 py-3 sm:px-4', i < stats.length - 1 && 'border-r-2 border-ink')}>
              <p className="text-[12px] font-semibold text-foreground-secondary">{k}</p>
              <p className="mt-1 font-display text-[22px] font-extrabold leading-none tracking-[-0.04em] text-ink tabular-nums sm:text-[30px]">{v}</p>
            </div>
          ))}
        </div>
        <div className="px-5 pt-4 pb-7 sm:px-6">
          <p className="text-[13px] font-bold text-ink">Priority learning gaps</p>
          <ul className="mt-3 space-y-3">
            {gaps.map((g) => (
              <li key={g.topic}>
                <div className="flex items-center justify-between gap-3 text-[14px]">
                  <span className="font-medium text-ink">{g.topic}</span>
                  <span className="font-semibold text-ink tabular-nums">{g.pct}%</span>
                </div>
                <div className="mt-1.5 h-3 w-full overflow-hidden rounded-full border-[1.5px] border-ink bg-sunken">
                  <div className="h-full border-r-[1.5px] border-ink bg-coral" style={{ width: `${g.pct}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
        <Sticker tone="lime" tilt={5} className="absolute -bottom-4 right-3 px-3.5 py-2 text-[13px] shadow-hard-sm sm:-right-5">
          <CheckCircle2 className="h-4 w-4" strokeWidth={2.6} />
          Checked by Skyll · 40/40 answers
        </Sticker>
      </div>

      <div className="relative ml-auto mt-10 w-[88%] max-w-[300px] rotate-2 rounded-2xl border-2 border-ink bg-card p-4 shadow-hard-md sm:absolute sm:bottom-0 sm:-left-8 sm:mt-0 sm:w-[290px]">
        <p className="text-[12px] font-bold uppercase tracking-[0.1em] text-foreground-secondary">Student · Quadratic equations</p>
        <p className="mt-2 flex items-baseline gap-2 text-ink">
          <span className="text-[14px] font-semibold">Mastery</span>
          <span className="font-display text-[40px] font-extrabold leading-none tracking-[-0.05em] tabular-nums">72%</span>
          <span className="text-[14px] font-semibold text-foreground-secondary tabular-nums">(64–80%)</span>
        </p>
        <div className="relative mt-3 h-3.5 rounded-full border-[1.5px] border-ink bg-sunken">
          <div className="absolute inset-y-0 bg-seq-1" style={{ left: '64%', width: '16%' }} />
          <div className="absolute -top-[5px] h-[19px] w-[5px] -translate-x-1/2 rounded-[3px] bg-ink" style={{ left: '72%' }} />
        </div>
        <p className="mt-2.5 text-[13px] text-foreground-secondary">8 curriculum-tagged signals, 3 exams</p>
      </div>
    </div>
  );
}

function InstitutesStrip() {
  const items = [...INSTITUTES, ...INSTITUTES];
  return (
    <div className="w-full overflow-hidden">
      <div className="animate-marquee flex w-max motion-reduce:animate-none">
        {[0, 1].map((half) => (
          <div key={half} className="flex shrink-0 items-center gap-14 pr-14 sm:gap-24 sm:pr-24">
            {items.map((item, i) => (
              <img key={`${half}-${i}`} src={item.src} alt={half === 0 ? item.alt : ''} loading="lazy" className={`${item.className} w-auto object-contain grayscale transition hover:grayscale-0`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Landing() {
  const { hash } = useLocation();

  // Header and footer link to /#how-it-works, /#pilot and so on. React Router
  // does not scroll to a hash on client-side navigation, so do it here.
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash]);

  return (
    <div className="min-h-screen overflow-x-hidden bg-background text-foreground">
      <Header />

      <main>
        {/* Hero */}
        <section className="notebook-grid relative">
          <div className="layout-container grid items-center gap-14 py-14 sm:py-20 lg:grid-cols-[1.08fr_1fr] lg:gap-12 lg:py-24">
            <div className="max-w-2xl">
              <p className="inline-flex items-center gap-2 rounded-full border-2 border-ink bg-card px-3.5 py-1.5 text-[13px] font-bold text-ink">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-action" />
                For coaching institutes, language institutes and schools
              </p>
              <h1 className={cn(display, 'mt-6 text-[46px] text-ink sm:text-[64px] lg:text-[64px] xl:text-[80px]')}>
                Handwritten exams, marked for you.
                <span className="mt-2 block">Your teachers <Highlight>mark nothing.</Highlight></span>
              </h1>
              <p className="mt-7 max-w-xl text-lg leading-relaxed text-foreground-secondary sm:text-xl">
                Your staff scan answer sheets on campus with the Skyll app. Our AI marks every answer, Skyll’s reviewers check the marking, and every student, parent and teacher gets a clear report within 24 hours, with each student’s gaps mapped.
              </p>
              <div className="mt-9 flex flex-col gap-4 sm:flex-row">
                <Button asChild className={loudPrimary}>
                  <Link to="/partner">Start your free trial <ArrowRight className="h-5 w-5" aria-hidden="true" /></Link>
                </Button>
                <Button asChild variant="outline" className={loudSecondary}>
                  <Link to="/demo">See a sample report</Link>
                </Button>
              </div>
              <dl className="mt-12 grid max-w-lg grid-cols-3 gap-4 border-t-2 border-ink pt-6">
                {[[PROOF.papers, 'answer sheets marked'], [PROOF.questions, 'answers marked'], [PROOF.institutes, 'institutes live']].map(([n, label]) => (
                  <div key={label} className="flex flex-col">
                    <dt className="order-2 mt-1.5 text-[13px] leading-snug text-foreground-secondary sm:text-sm">{label}</dt>
                    <dd className="order-1 font-display text-[24px] font-extrabold leading-none tracking-[-0.04em] text-ink tabular-nums sm:text-[40px] lg:text-[34px] xl:text-[40px]">{n}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="relative lg:pl-4">
              <HeroPreview />
            </div>
          </div>
        </section>

        {/* Logos */}
        <section className="border-y-2 border-ink bg-card py-8">
          <div className="layout-container">
            <p className="mb-6 text-center text-[13px] font-bold uppercase tracking-[0.12em] text-ink">
              Running in {PROOF.institutes} institutes across {PROOF.cities}
            </p>
            <InstitutesStrip />
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="scroll-mt-24 py-16 sm:py-24">
          <div className="layout-container">
            <SectionHeading eyebrow="How it works" title="Three steps. Nothing changes in your exam hall." />
            <ol className="mt-12 grid gap-6 md:grid-cols-3">
              {STEPS.map((step, i) => {
                const last = i === STEPS.length - 1;
                return (
                  <li
                    key={step.title}
                    className={cn(
                      'relative flex flex-col rounded-2xl border-2 border-ink p-6 sm:p-7',
                      last ? 'bg-ink text-white shadow-[5px_5px_0_var(--lime)]' : 'bg-card text-ink',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className={cn('flex h-12 w-12 items-center justify-center rounded-xl border-2', last ? 'border-lime bg-lime text-ink' : 'border-ink bg-paper text-ink')}>
                        <step.icon className="h-6 w-6" aria-hidden="true" />
                      </span>
                      <span
                        className={cn('rounded-full border-2 px-2.5 py-0.5 text-[14px] font-bold tabular-nums', last ? 'border-lime bg-lime text-ink' : 'border-ink bg-card text-ink')}
                        style={{ transform: `rotate(${[-4, 3, -3][i]}deg)` }}
                      >
                        0{i + 1}
                      </span>
                    </div>
                    <h3 className={cn(heading, 'mt-6 text-[26px]', last ? 'text-white' : 'text-ink')}>{step.title}</h3>
                    <p className={cn('mt-3 text-[15px] leading-relaxed sm:text-base', last ? 'text-white/80' : 'text-foreground-secondary')}>{step.body}</p>
                  </li>
                );
              })}
            </ol>
            <p className="mt-8 text-[15px] text-foreground-secondary">
              Want the statistics behind the reports?{' '}
              <Link to="/learner-dna" className={cn('rounded font-semibold text-action underline decoration-2 underline-offset-4 hover:text-action-pressed', linkFocus)}>Read how Learner DNA measures mastery</Link>.
            </p>
          </div>
        </section>

        {/* Audiences */}
        <section className="border-y-2 border-ink bg-card py-16 sm:py-24">
          <div className="layout-container">
            <SectionHeading eyebrow="What each person gets" title="One exam. Four views of it." />
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {AUDIENCES.map((a) => (
                <div key={a.title} className="rounded-2xl border-2 border-ink bg-paper p-6">
                  <span className={cn('flex h-11 w-11 items-center justify-center rounded-xl border-2 border-ink text-ink', a.tile)}>
                    <a.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className={cn(heading, 'mt-5 text-[22px] text-ink')}>{a.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-foreground-secondary">{a.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Proof */}
        <section className="py-16 sm:py-24">
          <div className="layout-container">
            <SectionHeading eyebrow="Already in use" title="Real exams, real institutes." intro={`Every number here comes from live exams in ${PROOF.cities}, not a pilot deck.`} />
            <dl className="mt-12 grid grid-cols-2 overflow-hidden rounded-[20px] border-2 border-ink bg-card shadow-hard-lg lg:grid-cols-4">
              {[[PROOF.papers, 'answer sheets marked'], [PROOF.questions, 'individual answers marked'], [PROOF.institutes, 'institutes live'], [PROOF.cityCount, 'cities']].map(([n, label], i) => (
                <div
                  key={label}
                  className={cn(
                    'flex flex-col p-5 sm:p-7',
                    i % 2 === 0 && 'border-r-2 border-ink',
                    i < 2 && 'border-b-2 border-ink lg:border-b-0',
                    i === 1 && 'lg:border-r-2',
                  )}
                >
                  <dt className="order-2 mt-2 text-[14px] text-foreground-secondary sm:text-[15px]">{label}</dt>
                  <dd className="order-1 font-display text-[36px] font-extrabold leading-none tracking-[-0.05em] text-ink tabular-nums sm:text-[56px] lg:text-[44px] xl:text-[56px]">{n}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-10 grid gap-5 md:grid-cols-2">
              {TESTIMONIALS.map((t) => (
                <figure key={t.author} className="flex flex-col rounded-2xl border-2 border-ink bg-card p-6 sm:p-7">
                  <span aria-hidden="true" className="font-display text-[56px] font-extrabold leading-[0.6] text-action">“</span>
                  <blockquote className="mt-3 font-display text-[21px] font-semibold leading-snug tracking-[-0.02em] text-ink">{t.quote}</blockquote>
                  <figcaption className="mt-5 inline-flex w-fit items-center rounded-full bg-sunken px-3 py-1 text-[14px] font-bold text-ink">{t.author}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>

        {/* Trust: the one ink band on the page */}
        <section id="trust" className="scroll-mt-24 border-y-2 border-ink bg-ink py-16 text-white sm:py-24">
          <div className="layout-container">
            <SectionHeading dark eyebrow="Why you can trust it" title="Built for the questions a principal actually asks." />
            <div className="mt-12 grid gap-5 md:grid-cols-2">
              {TRUST.map((t) => (
                <div key={t.title} className="rounded-2xl border-2 border-white/20 p-6 sm:p-7">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-lime text-ink">
                    <t.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className={cn(heading, 'mt-5 text-[24px] text-white')}>{t.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-white/75 sm:text-base">{t.body}</p>
                </div>
              ))}
            </div>
            <div className="mt-10 flex flex-wrap gap-x-7 gap-y-3 text-[15px] font-semibold">
              {[['/dpdp-compliance', 'DPDP compliance statement'], ['/privacy', 'Privacy notice'], ['/grievance-officer', 'Grievance officer']].map(([to, label]) => (
                <Link key={to} to={to} className="rounded text-lime underline decoration-lime/40 decoration-2 underline-offset-4 hover:decoration-lime focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime">
                  {label}
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Demo */}
        <section id="demo" className="notebook-grid scroll-mt-24 py-16 sm:py-24">
          <div className="layout-container">
            <SectionHeading eyebrow="See it yourself" title="Open the demo. No sign-up, sample data." intro="A fictional class of ten students, with the same dashboard and reports your teachers would use." />
            <div className="mt-12 grid gap-5 md:grid-cols-3">
              {DEMOS.map((c) => (
                <Link
                  key={c.to}
                  to={c.to}
                  className={cn('group flex flex-col rounded-2xl border-2 border-ink bg-card p-6 transition-[transform,box-shadow] duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-hard-lg motion-reduce:transition-none sm:p-7', linkFocus)}
                >
                  <h3 className={cn(heading, 'text-[24px] text-ink')}>{c.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-foreground-secondary">{c.body}</p>
                  <span className="mt-6 inline-flex items-center gap-1.5 text-[15px] font-bold text-action">
                    Open <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* AI Labs (separate product) */}
        <section id="ai-labs" className="scroll-mt-24 border-y-2 border-ink bg-card py-16 sm:py-24">
          <div className="layout-container grid items-center gap-12 lg:grid-cols-2">
            <div>
              <p className="inline-flex items-center rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-bold text-lime">Also from Skyll · AI Labs</p>
              <h2 className={cn(heading, 'mt-5 text-[32px] text-ink sm:text-[44px]')}>Turn the CBSE AI mandate into a programme students enjoy.</h2>
              <p className="mt-5 text-[17px] leading-relaxed text-foreground-secondary sm:text-lg">
                AI and computational thinking becomes mandatory for Classes 3 to 8 from 2026–27. Skyll AI Labs runs hands-on workshops, from a two-day intensive to a twelve-week programme, where students build with AI rather than just hear about it.
              </p>
              <ul className="mt-7 grid gap-3 sm:grid-cols-2">
                {[[CheckCircle2, 'Responsible AI'], [Lightbulb, 'Prompting that works'], [Palette, 'Creative tools'], [Bot, 'Building real products']].map(([Icon, label]) => (
                  <li key={label} className="flex items-center gap-3 text-[15px] font-semibold text-ink">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-2 border-ink bg-paper"><Icon className="h-4 w-4" aria-hidden="true" /></span>
                    {label}
                  </li>
                ))}
              </ul>
              <div className="mt-9">
                <Button asChild variant="outline" className={loudSecondary}>
                  <Link to="/labs"><Code className="h-5 w-5" aria-hidden="true" /> Explore AI Labs</Link>
                </Button>
              </div>
            </div>
            <div className="relative px-2 pt-4 sm:px-6">
              <Tape className="-top-1 left-10" tilt={-6} />
              <div className="overflow-hidden rounded-[20px] border-2 border-ink bg-card shadow-hard-lg lg:rotate-[1.5deg]">
                <img src={aiLabsImage} alt="Students in a Skyll AI Labs workshop" width="1400" height="933" loading="lazy" className="block w-full object-cover" />
              </div>
            </div>
          </div>
        </section>

        {/* Pilot & pricing */}
        <section id="pilot" className="scroll-mt-24 py-16 sm:py-24">
          <div className="layout-container">
            <div className="relative rounded-[24px] border-2 border-ink bg-lime p-7 shadow-hard-lg sm:p-12 lg:grid lg:grid-cols-[1.2fr_1fr] lg:items-center lg:gap-12">
              <Sticker tone="coral" tilt={-5} className="absolute -top-4 right-6 px-3.5 py-2 text-[14px] sm:right-10">
                No setup fee
              </Sticker>
              <div>
                <Eyebrow>Free trial and pricing</Eyebrow>
                <h2 className={cn(heading, 'mt-4 text-[36px] text-ink sm:text-[56px]')}>Start with 30 answer sheets, free.</h2>
                <p className="mt-5 text-[17px] leading-relaxed text-ink sm:text-lg">
                  Send us 30 answer sheets from your next test. We mark them and send the marked sheets and a report for every student within 24 hours, free. After that you pay a simple price per student: monthly for institutes, yearly for schools, with reports included. No setup fee, no annual contract, and you can stop any time.
                </p>
                <ul className="mt-7 space-y-3 text-[15px] font-semibold text-ink sm:text-base">
                  {['Scanning on campus with the Skyll app', 'Skyll’s reviewers check every answer', 'Reports for students, parents and teachers', 'GST invoice, monthly or yearly'].map((item) => (
                    <li key={item} className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink text-lime">
                        <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-10 flex flex-col gap-4 rounded-2xl border-2 border-ink bg-card p-5 sm:p-6 lg:mt-0">
                <Button asChild className={cn(loudPrimary, 'w-full')}>
                  <Link to="/partner">Start your free trial <ArrowRight className="h-5 w-5" aria-hidden="true" /></Link>
                </Button>
                <Button asChild variant="outline" className={cn(loudSecondary, 'w-full')}>
                  <a href={`mailto:${CONTACT_EMAIL}?subject=Skyll%20pricing`}>
                    <Mail className="h-5 w-5" aria-hidden="true" /> Email us for pricing
                  </a>
                </Button>
                <p className="text-center text-[13px] text-foreground-secondary">We reply within one working day.</p>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-24 border-y-2 border-ink bg-card py-16 sm:py-24">
          <div className="layout-container grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
            <SectionHeading eyebrow="Questions" title="The things institutes ask before a trial." className="lg:sticky lg:top-28 lg:self-start" />
            <div className="space-y-3">
              {FAQ.map((item) => (
                <details key={item.q} className="group rounded-2xl border-2 border-ink bg-paper open:bg-card">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-4 text-[17px] font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-6 [&::-webkit-details-marker]:hidden">
                    {item.q}
                    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-card transition-transform group-open:rotate-45 group-open:bg-lime motion-reduce:transition-none">
                      <Plus className="h-4 w-4" strokeWidth={2.6} />
                    </span>
                  </summary>
                  <p className="px-5 pb-5 text-[15px] leading-relaxed text-foreground-secondary sm:px-6 sm:text-base">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="notebook-grid py-20 sm:py-28">
          <div className="layout-container text-center">
            <h2 className={cn(display, 'mx-auto max-w-4xl text-[44px] text-ink sm:text-[64px] lg:text-[80px]')}>
              Bring 30 answer sheets. Keep <Highlight>the insight.</Highlight>
            </h2>
            <p className="mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-foreground-secondary sm:text-lg">Tell us the exam date and the number of students. We set your staff up with the Skyll app and handle the rest.</p>
            <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Button asChild className={loudPrimary}>
                <Link to="/partner">Start your free trial <ArrowRight className="h-5 w-5" aria-hidden="true" /></Link>
              </Button>
              {WHATSAPP_NUMBER && (
                <Button asChild variant="outline" className={loudSecondary}>
                  <a href={`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent('Hi Skyll, I would like to start a free trial.')}`} target="_blank" rel="noopener noreferrer">
                    <MessageCircle className="h-5 w-5" aria-hidden="true" /> WhatsApp us
                  </a>
                </Button>
              )}
              <a href={`mailto:${CONTACT_EMAIL}`} className={cn('inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-base font-bold text-ink underline decoration-2 underline-offset-4 hover:decoration-action', linkFocus)}>
                <Mail className="h-5 w-5" aria-hidden="true" /> {CONTACT_EMAIL}
              </a>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
