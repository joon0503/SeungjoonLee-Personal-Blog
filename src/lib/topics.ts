/**
 * Topic registry. An article's `topics` frontmatter must use these ids
 * (validated in src/content.config.ts), so a typo fails the build instead
 * of silently creating a new topic page.
 *
 * Order here is the display order on the home and topics pages.
 */
export const TOPICS = {
  control: {
    title: 'Control',
    description: 'Feedback, stability, optimal control and estimation.',
  },
  'linear-algebra': {
    title: 'Linear Algebra',
    description: 'Geometry of matrices, decompositions and least squares.',
  },
  'computer-vision': {
    title: 'Computer Vision',
    description: 'Cameras, projective geometry, calibration and 3D reconstruction.',
  },
  'machine-learning': {
    title: 'Machine Learning',
    description: 'Learning from data, from linear models to deep networks.',
  },
  robotics: {
    title: 'Robotics',
    description: 'Kinematics, rigid-body motion, planning and manipulation.',
  },
  optimization: {
    title: 'Optimization',
    description: 'Convex and nonlinear optimization as a working tool.',
  },
} as const satisfies Record<string, { title: string; description: string }>;

export type TopicId = keyof typeof TOPICS;

export const TOPIC_IDS = Object.keys(TOPICS) as [TopicId, ...TopicId[]];

export function topicTitle(id: TopicId): string {
  return TOPICS[id].title;
}

export function topicHref(id: TopicId): string {
  return `/topics/${id}/`;
}
