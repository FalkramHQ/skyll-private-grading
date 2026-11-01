import { Check, Sparkles, BrainCircuit, Lightbulb, Code, Palette, Laptop, Mail } from 'lucide-react';
import Header from '../components/Header';
import Footer from '../components/Footer';
import { Button } from '../components/ui/Button';
import { Sticker } from '../components/ui/Sticker';
import { Eyebrow, SectionHeading, Tape, display, heading, loudPrimary } from '../components/marketing/Notebook';
import { cn } from '../lib/utils';

// Institutional Logos
import iitBombayLogo from '../assets/logo-iitbombay.webp';
import nitkLogo from '../assets/logo-nitk.webp';
import mitLogo from '../assets/logo-mit.webp';

// The three.js ParticleField used to sit behind this hero. The Skyll Notebook
// style is flat paper and ink, so it is no longer rendered here (the component
// still exists in components/three/).

const LOGOS = [
  { src: iitBombayLogo, alt: 'IIT Bombay' },
  { src: 'https://cmsredesign.channeli.in/library/assets/images/iitrLogo.png', alt: 'IIT Roorkee' },
  { src: nitkLogo, alt: 'NITK Surathkal' },
  { src: mitLogo, alt: 'MIT Manipal' },
];

const OUTCOMES = [
  { icon: BrainCircuit, title: 'Responsible AI', desc: 'Understand generative AI deeply and use it ethically and safely.', tile: 'bg-lime' },
  { icon: Lightbulb, title: 'Master Prompting', desc: 'Write strong prompts and iterate to achieve high-quality results.', tile: 'bg-coral' },
  { icon: Palette, title: 'Multimedia Creation', desc: 'Create voiceovers, podcasts, music, images, and videos.', tile: 'bg-action-tint' },
  { icon: Laptop, title: '3D & Immersive', desc: 'Understand 3D printing workflows and AR/VR concepts.', tile: 'bg-sunken' },
  { icon: Code, title: 'Product Building', desc: 'Build functional prototypes and student-level products.', tile: 'bg-lime' },
  { icon: Sparkles, title: 'Problem Solving', desc: 'Apply optimization, iteration, and critical thinking.', tile: 'bg-coral' },
];

const MONTHS = [
  {
    title: 'Month 1: AI Foundations & Text',
    weeks: 'Weeks 1-4',
    items: [
      ['Week 1:', 'Intro to Generative AI, Safety, and Ethics'],
      ['Week 2:', 'Prompt Engineering & Idea Development'],
      ['Week 3:', 'AI Text, Speech, and Voice Tools (Storytelling)'],
      ['Week 4:', 'Music Generation & Audio Creativity'],
    ],
  },
  {
    title: 'Month 2: Visual, 3D & Immersive',
    weeks: 'Weeks 5-8',
    items: [
      ['Week 5:', 'AI Image Generation & Concept Art'],
      ['Week 6:', 'AI Video Generation & Storyboarding'],
      ['Week 7:', '3D Generation & Design Thinking'],
      ['Week 8:', '3D Printing Workflows & AR/VR Concepts'],
    ],
  },
  {
    title: 'Month 3: Capstone & Problem Solving',
    weeks: 'Weeks 9-12',
    items: [
      ['Week 9:', 'Identifying Problems & Optimizing Solutions'],
      ['Week 10:', 'Building Useful AI Projects (Capstone Kickoff)'],
      ['Week 11:', 'Testing, Improvement & Presentation Prep'],
      ['Week 12:', 'Final Showcase, Evaluation & Certification'],
    ],
  },
];

const TAKE_HOME = [
  'AI Skills Workbook & Prompt Handbook',
  'Comprehensive Project Portfolio',
  'Audio, Image, Video, and 3D Samples',
  'Final Capstone Project & Presentation Experience',
  'Official Completion Certificate',
];

export default function AILabs() {
  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-background text-ink">
      <Header />

      <main className="flex-1">
        {/* Hero: the one ink band on this page */}
        <section className="border-b-2 border-ink bg-ink text-white">
          <div className="layout-container py-20 text-center sm:py-28">
            <Eyebrow dark>Also from Skyll</Eyebrow>
            <h1 className={cn(display, 'mx-auto mt-6 max-w-4xl text-[52px] text-white sm:text-[80px] lg:text-[104px]')}>
              Skyll <span className="text-lime">AI Labs</span>
            </h1>
            <p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-white/80 sm:text-xl">
              Equip your students with the skills of tomorrow. Whether through an intensive 2-day workshop or our comprehensive 12-week program, students build, create, and solve real-world problems using cutting-edge Generative AI.
            </p>
            <div className="mt-10 flex justify-center">
              {/* On the ink band an ink shadow would vanish, so this one is paper. */}
              <Button asChild variant="lime" className={loudPrimary} style={{ boxShadow: '4px 4px 0 var(--paper)' }}>
                <a href="mailto:hello@skyll.in?subject=Inquiry%20about%20Skyll%20AI%20Labs%20Custom%20Programs">
                  <Mail className="h-5 w-5" aria-hidden="true" /> Contact Us
                </a>
              </Button>
            </div>
          </div>
        </section>

        {/* Workshops delivered */}
        <section className="border-b-2 border-ink bg-card py-8">
          <div className="layout-container">
            <p className="mb-6 text-center text-[13px] font-bold uppercase tracking-[0.12em] text-ink">
              Workshops successfully delivered at premier institutions
            </p>
            <div className="flex overflow-hidden">
              <div className="animate-marquee flex w-max motion-reduce:animate-none">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="flex shrink-0 items-center gap-12 px-6 sm:gap-24 sm:px-12" aria-hidden={i > 0 ? 'true' : undefined}>
                    {LOGOS.map((logo) => (
                      <img key={logo.alt} src={logo.src} alt={i === 0 ? logo.alt : ''} className="h-10 shrink-0 object-contain grayscale transition hover:grayscale-0 sm:h-14" />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Learning outcomes */}
        <section className="notebook-grid py-16 sm:py-24">
          <div className="layout-container">
            <SectionHeading eyebrow="Why Skyll AI Labs?" title="Transforming Consumers into Creators" />
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {OUTCOMES.map((item) => (
                <div key={item.title} className="rounded-2xl border-2 border-ink bg-card p-6 sm:p-7">
                  <span className={cn('flex h-12 w-12 items-center justify-center rounded-xl border-2 border-ink text-ink', item.tile)}>
                    <item.icon className="h-6 w-6" aria-hidden="true" />
                  </span>
                  <h3 className={cn(heading, 'mt-5 text-[24px] text-ink')}>{item.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-foreground-secondary">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Curriculum */}
        <section className="border-y-2 border-ink bg-card py-16 sm:py-24">
          <div className="layout-container max-w-5xl">
            <SectionHeading eyebrow="The Journey" title="A 3-Month Transformational Curriculum" />
            <ol className="mt-12 space-y-6">
              {MONTHS.map((month, i) => (
                <li key={month.title} className="grid gap-4 rounded-2xl border-2 border-ink bg-paper p-6 sm:grid-cols-[auto_1fr] sm:gap-8 sm:p-8">
                  <div className="flex items-center gap-4 sm:flex-col sm:items-start">
                    <span className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-ink bg-lime font-display text-[26px] font-extrabold text-ink tabular-nums">{i + 1}</span>
                    <span className="rounded-full border-[1.5px] border-ink bg-card px-3 py-1 text-[13px] font-bold text-ink">{month.weeks}</span>
                  </div>
                  <div>
                    <h3 className={cn(heading, 'text-[24px] text-ink sm:text-[28px]')}>{month.title}</h3>
                    <ul className="mt-4 space-y-3 text-base leading-relaxed text-foreground-secondary sm:text-[17px]">
                      {month.items.map(([week, topic]) => (
                        <li key={week} className="flex gap-3">
                          <strong className="w-[4.75rem] shrink-0 font-semibold text-ink">{week}</strong>
                          <span>{topic}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Deliverables */}
        <section className="notebook-grid py-16 sm:py-24">
          <div className="layout-container grid items-center gap-14 lg:grid-cols-2">
            <div>
              <h2 className={cn(heading, 'text-[32px] text-ink sm:text-[44px]')}>What Students Take Home</h2>
              <p className="mt-5 text-[17px] leading-relaxed text-foreground-secondary sm:text-lg">
                Students leave the program not just with knowledge, but with a tangible portfolio of their AI creations.
              </p>
              <ul className="mt-8 space-y-4">
                {TAKE_HOME.map((item) => (
                  <li key={item} className="flex items-center gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-lime text-ink">
                      <Check className="h-4 w-4" strokeWidth={3} aria-hidden="true" />
                    </span>
                    <span className="text-base font-semibold text-ink">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative mx-auto w-full max-w-md px-2 pt-4" aria-hidden="true">
              <Tape className="top-0 left-8" tilt={-5} />
              <div className="rounded-[20px] border-2 border-ink bg-card shadow-hard-lg lg:rotate-2">
                <div className="flex gap-2 border-b-2 border-ink px-5 py-3.5">
                  <span className="h-3 w-3 rounded-full border-[1.5px] border-ink bg-coral" />
                  <span className="h-3 w-3 rounded-full border-[1.5px] border-ink bg-lime" />
                  <span className="h-3 w-3 rounded-full border-[1.5px] border-ink bg-card" />
                </div>
                <div className="space-y-3 px-6 py-6 font-mono text-[14px] text-foreground-secondary">
                  <p><span className="font-bold text-action">{'>'}</span> System initializing...</p>
                  <p><span className="font-bold text-action">{'>'}</span> Loading AI Models...</p>
                  <p><span className="font-bold text-action">{'>'}</span> Generating creative solutions...</p>
                </div>
                <p className="border-t-2 border-ink px-6 py-7 font-display text-[28px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink">
                  “AI is a tool. You are the creator.”
                </p>
              </div>
              <Sticker tone="coral" tilt={6} className="absolute -bottom-4 right-2 px-3.5 py-2 text-[14px]">
                12-week program
              </Sticker>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
