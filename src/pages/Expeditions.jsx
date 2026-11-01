import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Bot,
  Building2,
  Factory,
  Map,
  Network,
  Presentation,
  Route,
  ShipWheel,
  Users,
} from 'lucide-react';
import Header from '../components/Header';
import Footer from '../components/Footer';
import { buttonVariants } from '../components/ui/Button';
import { Sticker } from '../components/ui/Sticker';
import { cn } from '../lib/utils';

const expeditionExamples = [
  'How China manufactures at scale',
  'How Singapore manages water, ports and housing',
  'How Goa tourism really works',
  'How Bengaluru builds AI companies',
  'How Udupi fisheries and food supply chains function',
  'How geography shaped Mumbai wealth and inequality',
];

const investigationSteps = [
  { icon: Factory, title: 'Visit the system', desc: 'Factories, suppliers, ports, warehouses, markets, labs and civic control rooms.' },
  { icon: Users, title: 'Interview operators', desc: 'Founders, workers, engineers, distributors, officials and people affected by the system.' },
  { icon: Network, title: 'Map the chain', desc: 'Trace flows of material, money, labour, data, geography, incentives and constraints.' },
  { icon: Bot, title: 'Build the output', desc: 'An AI model, business proposal, field documentary or practical system redesign.' },
];

const academyTracks = [
  {
    title: 'How a City Works',
    question: 'How could AI improve one urban system?',
    visits: ['Water-treatment plant', 'Municipal control centre', 'Logistics warehouse', 'Factory or market'],
    output: 'Design a better waste, mobility or water system using field data.',
  },
  {
    title: 'Farm to Factory to Store',
    question: 'What really happens before a product reaches a shelf?',
    visits: ['Farm or landing centre', 'Processing unit', 'Warehouse', 'Retail or export hub'],
    output: 'Build a supply-chain map with unit economics, sustainability and branding choices.',
  },
];

const EYEBROW = 'text-[13px] font-bold uppercase tracking-[0.08em] text-foreground-secondary';
const H2 = 'font-display text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-foreground sm:text-[44px]';
const LOUD_CARD = 'rounded-[20px] border-2 border-ink bg-card';

export default function Expeditions() {
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <Header />

      <main className="flex-1">
        <section className="notebook-grid border-b-2 border-ink">
          <div className="mx-auto grid max-w-5xl gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1fr_0.82fr] lg:items-center">
            <div>
              <Sticker tone="ink" tilt={-3}>World Systems Expeditions</Sticker>
              <h1 className="mt-6 font-display text-[44px] font-extrabold leading-[1.02] tracking-[-0.04em] text-foreground sm:text-[56px]">
                Travel as investigation, access and <span className="bg-lime px-1.5 [box-decoration-break:clone]">creation</span>.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-relaxed text-foreground-secondary sm:text-lg">
                Participants do not travel to see places. They enter a city, industrial cluster or landscape to understand one major system through field access, real conversations, data collection and AI-powered outputs.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a
                  href="mailto:hello@skyll.in?subject=World%20Systems%20Expeditions"
                  className={cn(buttonVariants({ size: 'lg' }), 'h-[54px] rounded-[14px] border-2 px-6 text-base')}
                >
                  Build a program <ArrowRight className="h-5 w-5" aria-hidden="true" />
                </a>
                <Link
                  to="/labs"
                  className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'h-[54px] rounded-[14px] border-2 px-6 text-base')}
                >
                  See AI Labs
                </Link>
              </div>
            </div>

            <div className={`${LOUD_CARD} relative rotate-2 p-5 shadow-hard-lg`}>
              <span aria-hidden="true" className="absolute -top-3 left-1/2 h-6 w-24 -translate-x-1/2 -rotate-3 border-[1.5px] border-ink bg-lime" />
              <div className="flex items-center justify-between border-b-[1.5px] border-ink pb-3">
                <div>
                  <p className="text-[13px] font-bold text-foreground-secondary">Live brief</p>
                  <p className="mt-0.5 font-display text-lg font-bold">₹20 product journey</p>
                </div>
                <Route className="h-5 w-5 text-ink" aria-hidden="true" />
              </div>
              <ol className="mt-5 space-y-3.5">
                {['Raw material', 'Factory', 'Warehouse', 'Port', 'Retailer', 'Consumer'].map((stage, idx) => (
                  <li key={stage} className="flex items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-card font-display text-sm font-extrabold tabular-nums text-ink">
                      {idx + 1}
                    </span>
                    <span className="h-px flex-1 bg-hairline-strong" aria-hidden="true" />
                    <span className="w-28 text-[15px] font-semibold text-foreground">{stage}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
            <div>
              <p className={EYEBROW}>The model</p>
              <h2 className={`mt-3 ${H2}`}>
                Every expedition starts with a central question.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-foreground-secondary">
                Not an itinerary. Not a school picnic. A serious question that turns the region into a living classroom.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {expeditionExamples.map((example) => (
                <div key={example} className={`${LOUD_CARD} p-5`}>
                  <p className="font-display text-lg font-bold leading-snug">{example}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-y-2 border-ink bg-card">
          <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
            <div className="mb-10 max-w-2xl">
              <p className={EYEBROW}>Investigation flow</p>
              <h2 className={`mt-3 ${H2}`}>
                Field access becomes <span className="bg-lime px-1.5 [box-decoration-break:clone]">student work</span>.
              </h2>
            </div>

            <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {investigationSteps.map((item, idx) => {
                const Icon = item.icon;
                return (
                  <li key={item.title} className="rounded-[20px] border-2 border-ink bg-paper-soft p-5">
                    <div className="mb-4 flex items-center justify-between">
                      <span className="flex h-11 w-11 items-center justify-center rounded-xl border-[1.5px] border-ink bg-action-tint text-ink" aria-hidden="true">
                        <Icon className="h-5 w-5" />
                      </span>
                      <span className="font-display text-2xl font-extrabold tabular-nums text-foreground-secondary" aria-hidden="true">{String(idx + 1).padStart(2, '0')}</span>
                    </div>
                    <h3 className="text-lg">{item.title}</h3>
                    <p className="mt-2 text-[15px] leading-relaxed text-foreground-secondary">{item.desc}</p>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
            <div>
              <div className="mb-5 flex h-12 w-12 rotate-[-4deg] items-center justify-center rounded-xl border-2 border-ink bg-lime text-ink" aria-hidden="true">
                <Map className="h-5 w-5" />
              </div>
              <p className={EYEBROW}>For schools</p>
              <h2 className={`mt-3 ${H2}`}>
                World Systems Academy
              </h2>
              <p className="mt-4 text-base leading-relaxed text-foreground-secondary">
                A 3-7 day field program where students learn curriculum through the functioning world. Biology, chemistry, geography, economics, labour, logistics, sustainability and AI stop being separate chapters.
              </p>
            </div>

            <div className="grid gap-5">
              {academyTracks.map((track) => (
                <div key={track.title} className={`${LOUD_CARD} p-6`}>
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h3 className="font-display text-[21px]">{track.title}</h3>
                      <p className="mt-1 text-[15px] font-semibold text-foreground">{track.question}</p>
                    </div>
                    <Building2 className="h-5 w-5 shrink-0 text-ink" aria-hidden="true" />
                  </div>
                  <ul className="mt-5 grid gap-2 sm:grid-cols-2">
                    {track.visits.map((visit) => (
                      <li key={visit} className="rounded-xl border border-border bg-paper-soft px-4 py-3 text-[15px] font-medium text-foreground">
                        {visit}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-5 text-[15px] leading-relaxed text-foreground-secondary">{track.output}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 pb-16 sm:px-6 sm:pb-24">
          <div className="rounded-[24px] border-2 border-ink bg-ink p-8 text-white shadow-hard-lg sm:p-12">
            <div className="grid gap-8 lg:grid-cols-[1fr_0.9fr] lg:items-center">
              <div>
                <p className="text-[13px] font-bold uppercase tracking-[0.08em] text-lime">Final output</p>
                <h2 className="mt-3 font-display text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-white sm:text-[44px]">
                  Students present to the people involved.
                </h2>
                <p className="mt-4 text-base leading-relaxed text-white/80">
                  The work ends as a real-world deliverable: a system map, AI prototype, business case, documentary, or redesign proposal shared with the companies and institutions students learned from.
                </p>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2">
                {['Field data', 'System map', 'AI prototype', 'Business case', 'Documentary', 'Company presentation'].map((output) => (
                  <li key={output} className="rounded-xl border-[1.5px] border-white/30 px-4 py-3 text-[15px] font-semibold text-white">
                    {output}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
