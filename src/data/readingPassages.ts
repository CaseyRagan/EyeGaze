/**
 * Reading passages, written for this tool so they can be used freely.
 *
 * Each passage is roughly 110–140 words, which is long enough for the per-100-word
 * metrics to stabilise and short enough that a tired reader will finish it.
 * Comprehension questions exist so the reading rate can be reported *with*
 * comprehension — a rate without a comprehension check is not a reading measure,
 * it is a skimming measure.
 */

export interface ComprehensionQuestion {
  prompt: string;
  options: string[];
  correctIndex: number;
}

export interface ReadingPassage {
  id: string;
  title: string;
  /** Approximate grade level of the text itself. */
  level: number;
  levelLabel: string;
  text: string;
  questions: ComprehensionQuestion[];
}

export const READING_PASSAGES: ReadingPassage[] = [
  {
    id: 'garden',
    title: 'The Garden Snail',
    level: 2,
    levelLabel: 'Early reader',
    text: `A snail carries its house on its back. The house is a shell, and it grows a little bigger every year. When the sun is hot, the snail hides deep inside where the air stays cool and damp. At night, when the grass is wet, the snail comes out to eat. It has a rough tongue with many tiny teeth, and it scrapes at leaves the way a file scrapes at wood. A snail moves on one long foot. The foot makes a silver trail that shines in the morning. If you follow the trail, you can see everywhere the snail has been. Snails are slow, but they do not seem to mind. They have all night to get where they are going.`,
    questions: [
      {
        prompt: 'Where does the snail go when the sun is hot?',
        options: ['Into the wet grass', 'Deep inside its shell', 'Under a stone', 'Up a tree'],
        correctIndex: 1,
      },
      {
        prompt: 'What does the snail use to eat leaves?',
        options: ['A rough tongue with tiny teeth', 'Its shell', 'Its silver trail', 'Its long foot'],
        correctIndex: 0,
      },
      {
        prompt: 'What does the silver trail show you?',
        options: ['How old the snail is', 'What the snail ate', 'Where the snail has been', 'How fast the snail moved'],
        correctIndex: 2,
      },
    ],
  },
  {
    id: 'lighthouse',
    title: 'Keeping the Light',
    level: 5,
    levelLabel: 'Upper primary',
    text: `Before the lamps were automatic, someone had to live beside every lighthouse and keep the light burning. The work was mostly patience. A keeper wound the clockwork that turned the lens, trimmed the wick, polished the glass, and wrote the weather in a logbook every few hours, whether or not anything had happened. On calm nights this was dull. On rough nights it was not. Storms could rattle the tower hard enough to shake the flame, and a keeper might climb the stairs a dozen times before dawn to be certain the light still turned. The strange part is that a keeper almost never saw the ships that were saved. The evidence of a good night was simply that nothing went wrong, and nothing kept on going wrong, for years at a time.`,
    questions: [
      {
        prompt: 'What did the keeper write in the logbook?',
        options: ['The names of passing ships', 'The weather, every few hours', 'Repairs made to the tower', 'Letters home'],
        correctIndex: 1,
      },
      {
        prompt: 'Why might a keeper climb the stairs many times in one night?',
        options: [
          'To count the ships at sea',
          'To keep warm during the storm',
          'To be certain the light was still turning',
          'To fetch more oil from the store',
        ],
        correctIndex: 2,
      },
      {
        prompt: 'What does the passage say was the evidence of a good night?',
        options: [
          'A ship signalled its thanks',
          'The logbook was full',
          'The storm passed quickly',
          'Nothing went wrong',
        ],
        correctIndex: 3,
      },
    ],
  },
  {
    id: 'sourdough',
    title: 'A Jar of Flour and Water',
    level: 8,
    levelLabel: 'Middle school',
    text: `A sourdough starter is nothing more than flour and water left alone until something moves in. Wild yeasts and bacteria, already present on the grain and drifting in the air, settle into the paste and begin to feed. Within a week the mixture smells sharp and slightly sour, and it rises and falls on a schedule of its own. What makes a starter interesting is that it is a community rather than a single organism. The yeasts produce carbon dioxide, which lifts the dough; the bacteria produce acids, which give the bread its flavour and, incidentally, discourage competitors that might otherwise spoil it. The two groups depend on each other closely enough that a starter kept in one kitchen will slowly become unlike a starter kept in another, even if both began from the same jar.`,
    questions: [
      {
        prompt: 'What are the only two ingredients needed to begin a starter?',
        options: ['Flour and yeast', 'Flour and water', 'Water and sugar', 'Yeast and bacteria'],
        correctIndex: 1,
      },
      {
        prompt: 'According to the passage, what do the bacteria contribute?',
        options: [
          'Carbon dioxide that lifts the dough',
          'Warmth that speeds fermentation',
          'Acids that give flavour and discourage spoilage',
          'Proteins that strengthen the gluten',
        ],
        correctIndex: 2,
      },
      {
        prompt: 'Why do two starters from the same jar become different over time?',
        options: [
          'They are fed different flours on purpose',
          'The community adapts to each kitchen',
          'One is refrigerated and one is not',
          'The yeasts eventually die out',
        ],
        correctIndex: 1,
      },
    ],
  },
  {
    id: 'timekeeping',
    title: 'The Invention of Being Late',
    level: 12,
    levelLabel: 'Adult',
    text: `For most of human history, noon was a local event. It arrived when the sun stood highest over a particular town, which meant that noon in one city was several minutes adrift from noon in the next. Nobody minded, because nothing travelled fast enough for the discrepancy to matter. The railways ended this. A timetable is a promise about simultaneity, and a promise cannot be kept when every station along the line keeps its own hour. So the railway companies imposed a single time on their networks, and the towns eventually followed, sometimes reluctantly and occasionally by lawsuit. The result was a genuinely new experience. Once everyone agreed on what time it was, it became possible, for the first time, to be measurably and publicly late.`,
    questions: [
      {
        prompt: 'Before standard time, what determined noon in a given town?',
        options: [
          'The nearest railway station',
          'The position of the sun over that town',
          'A national almanac',
          'The local church bell schedule',
        ],
        correctIndex: 1,
      },
      {
        prompt: 'Why did the railways force the change?',
        options: [
          'Trains ran faster than the sun appeared to move',
          'Passengers demanded a single national clock',
          'A timetable is a promise about simultaneity',
          'Local time was too difficult to calculate',
        ],
        correctIndex: 2,
      },
      {
        prompt: 'What does the passage call a genuinely new experience?',
        options: [
          'Travelling between distant cities in a day',
          'Being measurably and publicly late',
          'Reading a printed timetable',
          'Disagreeing with a neighbouring town',
        ],
        correctIndex: 1,
      },
    ],
  },
];

export function wordCountOf(passage: ReadingPassage): number {
  return passage.text.trim().split(/\s+/).length;
}
