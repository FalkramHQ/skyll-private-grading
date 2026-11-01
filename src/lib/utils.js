import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Combines CSS class names with clsx and merges Tailwind classes cleanly with tailwind-merge.
 * @param {...(string|Object|Array|boolean|undefined|null)} inputs
 * @returns {string}
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
