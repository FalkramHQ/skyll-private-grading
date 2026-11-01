import playstoreLogo from '../assets/playstore.png';

// The Skyll Intake app (Android) is what scanning teams use on campus. The iOS
// build is not published, so no App Store badge is shown until it is.
export default function AppStoreBadges({ className = '' }) {
  return (
    <div className={`flex flex-wrap items-center gap-3 sm:gap-4 ${className}`}>
      <a
        href="https://play.google.com/store/apps/details?id=com.skyll.intake&hl=en_IN"
        target="_blank"
        rel="noopener noreferrer"
        className="press inline-flex h-[54px] min-w-[170px] items-center gap-3 rounded-xl border-2 border-ink bg-ink px-4 py-2 text-white shadow-hard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <img src={playstoreLogo} alt="" width="32" height="32" className="h-8 w-8 object-contain" />
        <span className="flex flex-col items-start leading-none pr-2">
          <span className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/80">Get it on</span>
          <span className="font-display text-[19px] font-bold tracking-[-0.02em]">Google Play</span>
        </span>
      </a>
    </div>
  );
}
