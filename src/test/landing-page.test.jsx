import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import Landing, { PROOF } from '../pages/Landing';
import Header from '../components/Header';

afterEach(cleanup);

function renderLanding(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Landing />
    </MemoryRouter>,
  );
}

describe('landing page first impression', () => {
  it('leads with an outcome headline and two calls to action in the hero', () => {
    renderLanding();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toMatch(/marked for you/i);
    expect(heading.textContent).toMatch(/your teachers mark nothing/i);
    const trialLinks = screen.getAllByRole('link', { name: /start your free trial/i });
    expect(trialLinks.length).toBeGreaterThanOrEqual(2);
    expect(trialLinks.every((a) => a.getAttribute('href') === '/partner')).toBe(true);
    expect(screen.getByRole('link', { name: /see a sample report/i })).toHaveAttribute('href', '/demo');
  });

  it('shows real proof numbers, never a fabricated person, and no overnight promise', () => {
    const { container } = renderLanding();
    const text = container.textContent;
    expect(text).toContain(PROOF.papers);
    expect(text).toContain(PROOF.questions);
    // A review count below the answer count reads as unreviewed answers.
    expect(text).not.toMatch(/review decisions/i);
    expect(text).not.toMatch(/overnight|next morning/i);
    // Testimonials are attributed to institutes only (no invented names or roles).
    const captions = container.querySelectorAll('figcaption');
    expect(captions.length).toBe(4);
    captions.forEach((c) => expect(c.textContent).toMatch(/Academy|Tutorials/));
  });

  it('keeps grading and AI Labs as separate stories and answers the trial questions', () => {
    renderLanding();
    expect(document.getElementById('how-it-works')).not.toBeNull();
    expect(document.getElementById('ai-labs')).not.toBeNull();
    expect(document.getElementById('pilot')).not.toBeNull();
    expect(document.getElementById('faq')).not.toBeNull();
    expect(screen.getByRole('heading', { name: /start with 30 answer sheets, free/i })).toBeInTheDocument();
    expect(screen.getByText(/does it work with messy handwriting/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /explore ai labs/i })).toHaveAttribute('href', '/labs');
    expect(screen.getByRole('link', { name: /falkram/i })).toHaveAttribute('href', 'https://www.falkram.com');
  });

  it('states the trust facts precisely: paper stays on campus, scans are processed by Skyll', () => {
    const { container } = renderLanding();
    expect(container.textContent).toMatch(/paper stays on your campus/i);
    expect(container.textContent).toMatch(/processed on Skyll/i);
    expect(container.textContent).toMatch(/our reviewers check every answer/i);
  });

  it('says who scans and who reviews: the institute scans with the app, Skyll’s reviewers check', () => {
    const { container } = renderLanding();
    expect(container.textContent).toMatch(/scan each answer sheet with the Skyll app/i);
    expect(container.textContent).toMatch(/Skyll’s reviewers check the marking/i);
    expect(container.textContent).not.toMatch(/your own teachers|portable scanners/i);
  });

  it('matches the sales kit offer: 30 free sheets in 24 hours, then per-student pricing', () => {
    const { container } = renderLanding();
    expect(container.textContent).toMatch(/30 answer sheets/i);
    expect(container.textContent).toMatch(/within 24 hours/i);
    expect(container.textContent).toMatch(/price per student/i);
    expect(container.textContent).not.toMatch(/per graded paper|day or two|first exam is free/i);
  });
});

describe('header', () => {
  it('has no dead "Get the App" button and offers the trial and demo', () => {
    render(<MemoryRouter><Header /></MemoryRouter>);
    expect(screen.queryByText(/get the app/i)).toBeNull();
    expect(screen.getByRole('link', { name: /start your free trial/i })).toHaveAttribute('href', '/partner');
    expect(screen.getByRole('link', { name: /try the demo/i })).toHaveAttribute('href', '/demo');
    expect(screen.getByRole('combobox', { name: /school login/i })).toBeInTheDocument();
  });
});
