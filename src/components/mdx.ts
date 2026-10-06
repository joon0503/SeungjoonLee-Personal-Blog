/**
 * Components available in every MDX article without an import.
 *
 * Register new interactive figures here so articles can simply write
 * `<PhasePortrait />`. Components used by a single article can instead be
 * imported directly at the top of that .mdx file.
 */
import Callout from './Callout.astro';
import Figure from './Figure.astro';
import PhasePortrait from './interactive/PhasePortrait.astro';
import Sidenote from './Sidenote.astro';

export const mdxComponents = {
  Callout,
  Figure,
  PhasePortrait,
  Sidenote,
};
