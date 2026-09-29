/** Site-wide settings. Edit freely. */
export const SITE = {
  title: 'Seungjoon Lee',
  author: 'Seungjoon Lee',
  tagline: 'Robotics · Control · Machine Learning',
  description:
    'Technical notes on control theory, linear algebra, computer vision, machine learning and robotics.',
  locale: 'en',
  links: {
    github: 'https://github.com/joon0503',
    linkedin: 'https://www.linkedin.com/in/seungjoon-lee-b455321a5',
    scholar: 'https://scholar.google.com/citations?user=pLYkIDMAAAAJ',
    email: 'sjoon0503@gmail.com',
  },
} as const;

export const NAV = [
  { href: '/articles/', label: 'Articles' },
  { href: '/topics/', label: 'Topics' },
  { href: '/about/', label: 'About' },
] as const;
