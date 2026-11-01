import { useRef, useEffect, useState } from 'react';
import { motion, useScroll, useTransform, AnimatePresence } from 'framer-motion';
import { ArrowRight, BarChart3, BookOpen, CheckCircle2, ChevronDown, ClipboardCheck, EyeOff, FileSearch, FileText, GitBranch, LeafyGreen, Map, ScanLine, Shield, Sprout, Target, Trash2, TreeDeciduous, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import Header from '../components/Header';
import Footer from '../components/Footer';
import { Button } from '../components/ui/Button';
import { Sticker } from '../components/ui/Sticker';
import { Eyebrow, Highlight, SectionHeading, Tape, display, heading, loudPrimary } from '../components/marketing/Notebook';
import { cn } from '../lib/utils';
import learnerDnaImg from '../assets/learner-dna.webp';
import learnerDnaHeroImg from '../assets/learner-dna-hero.webp';

const kcSteps = [
  { icon: BookOpen, name: 'Curriculum Standards', text: 'Every concept in CBSE Maths and Science is mapped to a curriculum standard, like "solve quadratic equations by factorisation" or "explain chemical bonding." These become the building blocks we measure.' },
  { icon: Target, name: 'Knowledge Components', text: 'We break each standard into specific Knowledge Components (KCs). Not vague topics, but precise skills. "Quadratic Equations" is a KC. "Using the discriminant to predict roots" is a KC. Granular enough to be useful.' },
  { icon: FileSearch, name: 'Question Mapping', text: 'Every exam question is tagged to the KCs it tests. When a student answers Q3 on their paper, we know exactly which knowledge components are being exercised, not just "Maths" but which part of Maths.' },
  { icon: GitBranch, name: 'Evidence Gate', text: 'Here is our promise: we only estimate mastery when we have measured, curriculum-aligned evidence. If a signal cannot be tagged to a KC, it does not count. No guessing. No fabricating certainty from ambiguous data.' },
  { icon: BarChart3, name: 'Bayesian Updating', text: 'Each KC-tagged signal updates the student\'s mastery estimate using Bayesian statistics. Start with a prior, add evidence, get a posterior. More data = narrower confidence intervals. The math is honest about what it knows.' },
  { icon: TrendingUp, name: 'Confidence Intervals', text: 'Parents see mastery as a percentage with a confidence range: "72% (64%–80%)." Wide intervals mean we need more evidence. Narrow intervals mean we are confident. No false precision, no fabricated labels.' },
];

const steps = [
  {
    num: '1',
    title: 'Schools run exams as usual',
    body: "Same paper. Same hall. Same process. We don't change a single thing about how your school operates.",
    icon: FileText,
    tile: 'bg-lime',
  },
  {
    num: '2',
    title: 'You scan on campus',
    body: "Your admin staff or teachers scan every answer sheet with the Skyll app, inside your walls. Not a single paper leaves the building. That's a promise.",
    icon: ScanLine,
    tile: 'bg-coral',
  },
  {
    num: '3',
    title: 'Marked, checked and reported within 24 hours',
    body: 'AI marks every paper, Skyll’s reviewers check the marking, and each student’s gaps are mapped. Reports are ready within 24 hours of scanning, with nothing for teachers to mark or review.',
    icon: ClipboardCheck,
    tile: 'bg-action-tint',
  },
];

const GROWTH = [
  { title: 'One Question', text: "A snapshot of today's learning.", icon: Sprout, num: '1' },
  { title: 'A Few Assignments', text: 'Patterns begin to appear.', icon: LeafyGreen, num: '2' },
  { title: 'Across the Whole Year', text: 'A confident picture of learning.', icon: TreeDeciduous, num: '3' },
];

const PROGRESSION = ['Individual answers', 'Evidence collected', 'Patterns emerge', 'Learner DNA'];

const FRAMEWORKS = [
  { title: 'DPDP Act, 2023 Compliant', body: 'Built in strict adherence to the Digital Personal Data Protection Act. By separating identity from data and ensuring localized processing, we exceed the mandates for handling children’s data (Section 9), ensuring zero behavioral tracking or profiling.' },
  { title: 'IT Act 2000 & SPDI Rules Ready', body: 'All aggregated insights and metadata in transit are secured with AES-256 encryption, adhering to the Sensitive Personal Data or Information (SPDI) rules for robust cybersecurity.' },
  { title: 'NEP 2020 Aligned Analytics', body: 'Our insight dashboards directly support the National Education Policy’s mandate for formative, competency-based assessments, helping schools transition from rote memorization tracking to holistic skill mapping.' },
  { title: 'School IP Protection', body: 'Your school owns 100% of your data. We never sell, share, or use your proprietary question papers or student handwriting to train public AI models.' },
];

function StepCard({ step, className }) {
  return (
    <div className={cn('relative flex flex-col rounded-[20px] border-2 border-ink bg-card p-7 shadow-hard-lg lg:p-9', className)}>
      <div className="flex items-center justify-between">
        <span className={cn('flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-ink text-ink', step.tile)}>
          <step.icon className="h-7 w-7" aria-hidden="true" />
        </span>
        <span className="rounded-full border-2 border-ink bg-card px-3 py-0.5 text-[15px] font-bold text-ink tabular-nums" style={{ transform: `rotate(${step.num === '2' ? 3 : -4}deg)` }}>
          0{step.num}
        </span>
      </div>
      <h3 className={cn(heading, 'mt-7 text-[26px] text-ink lg:text-[32px]')}>{step.title}</h3>
      <p className="mt-3 text-base leading-relaxed text-foreground-secondary">{step.body}</p>
    </div>
  );
}

function AccordionItem({ title, children, icon: Icon }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className={cn('overflow-hidden rounded-2xl border-2 border-ink transition-colors', isOpen ? 'bg-card' : 'bg-paper')}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className="flex min-h-16 w-full items-center justify-between gap-4 p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-6"
      >
        <span className="flex items-center gap-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-ink bg-card text-ink">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="font-display text-lg font-bold tracking-[-0.02em] text-ink sm:text-xl">{title}</span>
        </span>
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-ink transition-transform motion-reduce:transition-none', isOpen ? 'rotate-180 bg-lime' : 'bg-card')} aria-hidden="true">
          <ChevronDown className="h-4 w-4 text-ink" strokeWidth={2.6} />
        </span>
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="border-t border-hairline p-5 sm:p-6">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function LearnerDna() {
  const containerRef = useRef(null);
  const mobileScrollRef = useRef(null);

  useEffect(() => {
    window.scrollTo(0, 0);
    if (mobileScrollRef.current) {
      mobileScrollRef.current.scrollLeft = 0;
    }
  }, []);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end end"]
  });

  const x = useTransform(scrollYProgress, [0, 1], ["0%", "-66.66%"]);

  return (
    <div className="min-h-screen overflow-x-clip bg-background text-ink">
      <Header />
      <main>
        {/* Hero */}
        <section className="notebook-grid border-b-2 border-ink">
          <div className="layout-container grid items-center gap-14 py-14 sm:py-20 lg:grid-cols-2 lg:gap-12 lg:py-24">
            <div>
              <Eyebrow>Skyll Learner DNA</Eyebrow>
              <h1 className={cn(display, 'mt-6 text-[46px] text-ink sm:text-[64px] xl:text-[76px]')}>
                Mapping how every student <Highlight>learns best.</Highlight>
              </h1>
              <p className="mt-7 max-w-xl text-lg leading-relaxed text-foreground-secondary">Learner DNA isn't a personality test or a label. We use calibrated statistical models to measure mastery from real schoolwork, showing exactly what each student knows with scientific confidence intervals, not guesswork.</p>
              <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-foreground-secondary">Every insight is grounded in measured evidence. We only estimate mastery when we have curriculum-aligned signals, never from untagged or ambiguous data. The result: clear, actionable insights students, parents, and teachers can actually trust.</p>
              <div className="mt-9">
                <Button asChild className={loudPrimary}>
                  <Link to="/partner">Explore Skyll for your school <ArrowRight className="h-5 w-5" aria-hidden="true" /></Link>
                </Button>
              </div>
            </div>
            <div className="relative mx-auto w-full max-w-[560px] px-2 pt-4">
              <Tape className="top-0 left-1/2 -ml-12" tilt={-3} />
              <div className="overflow-hidden rounded-[20px] border-2 border-ink bg-card shadow-hard-lg lg:rotate-[1.5deg]">
                <img src={learnerDnaHeroImg} alt="Learner DNA overview" className="block h-auto w-full object-contain" />
              </div>
              <Sticker tone="coral" tilt={-5} className="absolute -bottom-4 left-4 px-3.5 py-2 text-[14px]">
                No guessing.
              </Sticker>
            </div>
          </div>
        </section>

        {/* === DESKTOP: Sticky horizontal scroll-jack === */}
        <div ref={containerRef} className="relative hidden h-[300vh] md:block">
          {/* Sticky container that stays pinned while scrolling */}
          <div className="sticky top-0 flex h-screen w-full flex-col overflow-hidden pb-16">
            <div className="z-10 w-full shrink-0 px-4 pt-28 text-center lg:pt-32">
              <Eyebrow>How it works</Eyebrow>
              <h2 className={cn(heading, 'mt-4 text-[44px] text-ink lg:text-[52px]')}>
                Three steps. Zero friction.
              </h2>
            </div>

            <div className="flex w-full flex-1 items-center py-8 lg:py-12">
              <motion.div style={{ x }} className="flex w-[300vw]">
                {steps.map((step) => (
                  <div key={step.num} className="flex w-[100vw] items-center justify-center px-6">
                    <StepCard step={step} className="w-full max-w-lg" />
                  </div>
                ))}
              </motion.div>
            </div>

            {/* Fixed Progress Bar */}
            <div className="absolute bottom-8 left-1/2 h-3.5 w-48 -translate-x-1/2 overflow-hidden rounded-full border-2 border-ink bg-card sm:w-64 lg:bottom-12" aria-hidden="true">
              <motion.div className="h-full bg-lime" style={{ scaleX: scrollYProgress, transformOrigin: 'left' }} />
            </div>
          </div>
        </div>

        {/* === MOBILE: Native horizontal snap scroll === */}
        <div className="flex w-full flex-col items-center pt-16 pb-14 md:hidden">
          <div className="mb-10 w-full px-4 text-center">
            <Eyebrow>How it works</Eyebrow>
            <h2 className={cn(heading, 'mt-4 text-[34px] text-ink')}>
              Three steps. Zero friction.
            </h2>
          </div>

          <div ref={mobileScrollRef} className="flex w-full snap-x snap-mandatory gap-5 overflow-x-auto px-5 pt-2 pb-8 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {steps.map((step) => (
              <div key={step.num} className="flex w-[85vw] max-w-sm shrink-0 snap-center">
                <StepCard step={step} className="w-full" />
              </div>
            ))}
          </div>
        </div>

        {/* The science */}
        <section id="mastery-science" className="border-y-2 border-ink bg-card py-16 sm:py-24">
          <div className="layout-container">
            <div className="grid items-center gap-12 lg:grid-cols-2">
              <SectionHeading
                eyebrow="The Science Behind It"
                title="How we measure what students actually know."
                intro="No personality labels. No learning styles. We measure mastery of specific curriculum concepts using Bayesian statistics, grounded in what students actually write on their answer sheets and mapped to what CBSE says they should know."
              />
              <div className="flex justify-center lg:justify-end">
                <img src={learnerDnaImg} alt="Students studying together" className="h-auto w-full max-w-[500px] object-contain" />
              </div>
            </div>

            <ol className="mt-12 divide-y divide-hairline overflow-hidden rounded-[20px] border-2 border-ink bg-card">
              {kcSteps.map(({ icon: Icon, name, text }, index) => (
                <li key={name} className="flex flex-col gap-4 px-5 py-6 sm:px-8 sm:py-7 lg:flex-row lg:items-center lg:gap-8">
                  <div className="flex shrink-0 items-center gap-4 lg:w-[300px]">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-ink bg-action-tint sm:h-14 sm:w-14">
                      <Icon className="h-6 w-6 text-ink" strokeWidth={2} aria-hidden="true" />
                    </span>
                    <div>
                      <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-foreground-secondary">Step {index + 1}</p>
                      <h3 className="mt-0.5 text-lg text-ink sm:text-xl">{name}</h3>
                    </div>
                  </div>
                  <p className="max-w-2xl flex-1 text-[15px] leading-relaxed text-foreground-secondary">{text}</p>
                </li>
              ))}
            </ol>

            <div className="mt-8 flex items-start gap-4 rounded-2xl border-2 border-ink bg-ink px-5 py-5 sm:items-center sm:px-8">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-lime">
                <CheckCircle2 className="h-5 w-5 text-ink" strokeWidth={2.5} aria-hidden="true" />
              </span>
              <p className="text-[15px] font-medium leading-relaxed text-white sm:text-base">Every mastery estimate traces back to measured evidence on a specific curriculum standard. No KC tag, no estimate. That is the evidence gate.</p>
            </div>
          </div>
        </section>

        {/* Always growing: the one ink band on this page */}
        <section className="border-b-2 border-ink bg-ink py-16 text-white sm:py-24">
          <div className="layout-container">
            <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr] lg:items-start">
              <div>
                <Eyebrow dark>Always Growing</Eyebrow>
                <h2 className={cn(heading, 'mt-4 text-[34px] text-white sm:text-[44px]')}>Focusing on<br />growth, not limits.</h2>
                <p className="mt-5 max-w-md text-[15px] leading-relaxed text-white/75 sm:text-base">Learning becomes clearer with more evidence. Our Bayesian models update mastery estimates as new signals arrive: starting wide and narrowing with confidence. We never judge students; we observe progress over time, only when we have measured, curriculum-aligned evidence.</p>
              </div>

              <ol className="grid gap-4 sm:grid-cols-3">
                {GROWTH.map((item) => (
                  <li key={item.num} className="rounded-2xl border-2 border-white/20 p-5">
                    <div className="flex items-center justify-between">
                      <span className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-lime text-lime">
                        <item.icon className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
                      </span>
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-lime text-[13px] font-bold text-ink tabular-nums">{item.num}</span>
                    </div>
                    <h3 className="mt-4 text-[18px] leading-snug text-white">{item.title}</h3>
                    <p className="mt-1 text-[14px] leading-relaxed text-white/70">{item.text}</p>
                  </li>
                ))}
              </ol>
            </div>

            <div className="mt-14 rounded-[20px] border-2 border-white/20 p-5 sm:p-8">
              <ol aria-label="Learner DNA Progression" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:gap-0">
                {PROGRESSION.map((label, i) => {
                  const last = i === PROGRESSION.length - 1;
                  return (
                    <li key={label} className="flex items-center gap-3 lg:pr-3">
                      <span className={cn('flex min-h-14 flex-1 items-center gap-3 rounded-xl border-2 px-4 py-3 text-[15px] font-bold', last ? 'border-lime bg-lime text-ink' : 'border-white/30 text-white')}>
                        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-[13px] tabular-nums', last ? 'border-ink' : 'border-lime text-lime')}>{i + 1}</span>
                        {label}
                      </span>
                      {!last && <ArrowRight className="hidden h-5 w-5 shrink-0 text-lime lg:block" aria-hidden="true" />}
                    </li>
                  );
                })}
              </ol>
              <p className="mt-6 text-center font-display text-[21px] font-bold tracking-[-0.02em] text-lime sm:text-[26px]">More evidence. More clarity. Stronger growth.</p>
            </div>
          </div>
        </section>

        {/* For the students */}
        <section className="notebook-grid py-16 sm:py-24">
          <div className="layout-container grid gap-14 lg:grid-cols-2 lg:items-center">
            <div>
              <SectionHeading eyebrow="For the Students" title="Clear and encouraging next steps." />
              <p className="mt-5 text-base leading-relaxed text-foreground-secondary">Instead of just receiving a grade, students see calibrated mastery estimates: what they know, how confident we are, and exactly where to focus next. Every insight is backed by measured evidence, not assumptions.</p>
              <p className="mt-4 text-base leading-relaxed text-foreground-secondary">We keep the insights clear and constructive. Everyone gets helpful advice and concrete examples from their own work, without any confusing educational jargon. When evidence is limited, we say so honestly with no fabricated certainty.</p>
            </div>
            <div className="relative mx-auto w-full max-w-lg px-2 pt-4">
              <Tape className="top-0 right-10" tilt={5} />
              <div className="rounded-[20px] border-2 border-ink bg-card p-6 shadow-hard-lg sm:p-8 lg:-rotate-1">
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-foreground-secondary">Example learning signal</p>
                  <Map className="h-5 w-5 text-ink" aria-hidden="true" />
                </div>
                <h3 className={cn(heading, 'mt-3 text-[24px] text-ink')}>Mastery: Quadratic Equations</h3>
                <div className="mt-5" aria-hidden="true">
                  <div className="flex items-baseline justify-between">
                    <span className="font-display text-[44px] font-extrabold leading-none tracking-[-0.05em] text-ink tabular-nums">72%</span>
                    <span className="text-[14px] font-semibold text-foreground-secondary tabular-nums">64%–80%</span>
                  </div>
                  <div className="relative mt-3 h-3.5 rounded-full border-[1.5px] border-ink bg-sunken">
                    <div className="absolute inset-y-0 bg-seq-1" style={{ left: '64%', width: '16%' }} />
                    <div className="absolute -top-[5px] h-[19px] w-[5px] -translate-x-1/2 rounded-[3px] bg-ink" style={{ left: '72%' }} />
                  </div>
                </div>
                <p className="mt-5 text-[15px] leading-relaxed text-foreground-secondary sm:text-base">Estimated mastery: <strong className="text-ink">72%</strong> (95% confidence: 64%–80%). You're building a solid foundation. Focus on completing the square and understanding the discriminant to strengthen this further.</p>
                <div className="mt-6 flex items-start gap-3 rounded-xl border border-hairline bg-paper-soft p-4 text-[13px] leading-relaxed text-foreground-secondary">
                  <FileSearch className="mt-0.5 h-4 w-4 shrink-0 text-ink" aria-hidden="true" />
                  <p><strong className="text-ink">Based on:</strong> 8 curriculum-tagged signals across 3 recent assessments.<br /><em>Note: Confidence intervals widen when evidence is limited, and we never fabricate certainty.</em></p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Detailed Compliance Statements ── */}
        <section className="border-y-2 border-ink bg-card py-16 sm:py-24">
          <div className="layout-container max-w-5xl">
            <SectionHeading title="Strict Adherence to Indian Frameworks" align="center" />
            <div className="mt-12 grid gap-5 sm:grid-cols-2">
              {FRAMEWORKS.map((f) => (
                <div key={f.title} className="rounded-2xl border-2 border-ink bg-paper p-6 sm:p-8">
                  <h3 className={cn(heading, 'text-[22px] text-ink')}>{f.title}</h3>
                  <p className="mt-3 text-[15px] leading-relaxed text-foreground-secondary sm:text-base">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Privacy Policy Section ── */}
        <section className="py-16 sm:py-24">
          <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
            <SectionHeading
              align="center"
              eyebrow="Legal & Trust"
              title="Privacy Policy (Ed-Tech Tailored)"
              intro="Because we handle data concerning minors, transparency is our highest priority. We use clear, straightforward practices to ensure your students are always protected."
            />

            <div className="mt-10 space-y-4">
              <AccordionItem title="Data Minimization" icon={Shield}>
                <p className="mb-4 leading-relaxed text-foreground-secondary">
                  We strictly collect only what is necessary to evaluate an exam. We <strong className="text-ink">do collect</strong> non-sensitive educational identifiers such as student roll number, grade, and school name.
                </p>
                <p className="font-semibold leading-relaxed text-ink">
                  We absolutely DO NOT collect biometrics, home addresses, phone numbers, or personal family information.
                </p>
              </AccordionItem>

              <AccordionItem title='The "No Tracking" Mandate' icon={EyeOff}>
                <p className="leading-relaxed text-foreground-secondary">
                  Student environments should be safe spaces. We categorically do not track student behavior over the internet, we do not serve advertisements, and we will never build marketing profiles on children. Our system is a closed-loop academic evaluation engine, nothing more.
                </p>
              </AccordionItem>

              <AccordionItem title="Data Erasure Policy" icon={Trash2}>
                <div className="mb-4 rounded-xl border-l-4 border-ink bg-paper-soft p-4">
                  <p className="text-[15px] font-semibold italic text-ink">
                    "Scanned images of answer scripts are automatically and permanently purged after grade finalization."
                  </p>
                </div>
                <p className="text-[15px] leading-relaxed text-foreground-secondary">
                  Once the AI has extracted the necessary text to map skills and grade answers, the physical raw image is no longer required. We enforce a strict, automated deletion policy to ensure sensitive handwritten data does not linger on any server.
                </p>
              </AccordionItem>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
