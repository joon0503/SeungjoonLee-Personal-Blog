/**
 * Components available in every MDX article without an import.
 *
 * Register new interactive figures here so articles can simply write
 * `<PhasePortrait />`. Components used by a single article can instead be
 * imported directly at the top of that .mdx file.
 */
import Figure from './Figure.astro';
import PhasePortrait from './interactive/PhasePortrait.astro';

export const mdxComponents = {
  Figure,
  PhasePortrait,
};
