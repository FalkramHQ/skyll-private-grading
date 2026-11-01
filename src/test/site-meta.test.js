/* global process */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
const meta = (attr, name) => html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1];

describe('static head for search and link previews', () => {
  it('has a description, canonical and a 1200x630 share image', () => {
    expect(meta('name', 'description')).toMatch(/grade|mark/i);
    expect(html).toContain('<link rel="canonical" href="https://www.skyllai.com/" />');
    expect(meta('property', 'og:image')).toBe('https://www.skyllai.com/og-image.png');
    expect(meta('property', 'og:image:width')).toBe('1200');
    expect(meta('property', 'og:image:height')).toBe('630');
    expect(meta('name', 'twitter:card')).toBe('summary_large_image');
    expect(fs.existsSync(path.resolve(process.cwd(), 'public/og-image.png'))).toBe(true);
  });

  it('never promises overnight turnaround in the page title or description', () => {
    expect(html).not.toMatch(/overnight/i);
  });
});
