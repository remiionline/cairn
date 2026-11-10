// Demo data: generic projects anyone can recognise, with about a year of
// completion history. Used by the browser preview, the smoke test, the
// screenshot script (`npm run screenshots`) and the try-it mode (`npm run demo`).
// Dates are relative to today and the "random" history uses a fixed seed, so
// every run looks the same apart from the dates.
import { Data, Repeat, Status, Task, emptyData, isoDate } from "./model";

let n = 0;
function daysAgo(d: number): string {
  const x = new Date();
  x.setDate(x.getDate() - d);
  return isoDate(x);
}

interface Extra { notes?: string; due?: number; repeat?: Repeat; created?: number }

/** A task. `done` = days ago it was completed; `due` = days from today. */
function t(text: string, status: Status = "todo", done: number | null = null, subtasks: Task[] = [], extra: Extra = {}): Task {
  return {
    id: `d${++n}`, text, status, created: daysAgo(extra.created ?? Math.max(done ?? 0, 0) + 20),
    completed: status === "done" ? daysAgo(done ?? 0) : null,
    ...(extra.notes ? { notes: extra.notes } : {}),
    ...(extra.due !== undefined ? { due: daysAgo(-extra.due) } : {}),
    ...(extra.repeat ? { repeat: extra.repeat } : {}),
    subtasks,
  };
}
const done = (text: string, ago: number, subtasks: Task[] = []) => t(text, "done", ago, subtasks);

/** Small seeded random generator (mulberry32), so the history is stable. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` finished tasks named from `names`, spread over the last `span` days, busier recently. */
function history(names: string[], count: number, span: number, seed: number, from = 1): Task[] {
  const r = rng(seed);
  const out: Task[] = [];
  for (let i = 0; i < count; i++) {
    const ago = from + Math.floor(Math.pow(r(), 1.6) * span);
    out.push(done(names[i % names.length], ago));
  }
  return out.sort((a, b) => b.completed!.localeCompare(a.completed!));
}

export function sampleData(): Data {
  n = 0;
  const d = emptyData();
  const daily: Repeat = { every: 1, unit: "day" };
  const weekly: Repeat = { every: 1, unit: "week" };

  // A daily habit with a long streak: fills the activity grid nicely.
  const practice: Task[] = [];
  const pr = rng(7);
  for (let ago = 1; ago < 340; ago++) if (pr() < (ago < 60 ? 0.85 : 0.45)) practice.push({ ...done("Practice session (30 min)", ago), repeat: { ...daily } });
  const lastPractice = practice[0];

  d.projects = [
    {
      id: "web", name: "Website Redesign", description: "A new portfolio site: design it, build it, launch it.", created: daysAgo(70),
      tasks: [
        t("Design the homepage", "doing", null, [
          done("Wireframes", 9), done("Pick a colour palette", 6),
          t("Hero section mockup", "doing"), t("Mobile layout"),
        ]),
        t("Build the contact form", "todo", null, [t("Form fields and validation"), t("Spam protection"), t("Email notification")], { due: 3 }),
        t("Write the About page", "todo", null, [], {
          due: 9,
          notes: "Keep it short: who I am, what I do, how to reach me.\nTone: friendly, not salesy.\n\nReference: https://example.com/about-page-tips\n\n- 150 words max\n- One photo\n- Link to CV",
        }),
        t("Set up hosting and domain", "todo", null, [], { due: 14 }),
        t("Compress and resize images"),
        t("Add analytics"),
        ...history(["Gather inspiration", "Content inventory", "Draft sitemap", "Choose a domain name", "Moodboard", "Pick fonts", "Write project case studies", "Set up the repository"], 14, 65, 11),
      ],
    },
    {
      id: "kitchen", name: "Kitchen Renovation", description: "Fresh paint, new cabinet handles and under-cabinet lights.", created: daysAgo(45),
      tasks: [
        t("Paint the walls", "doing", null, [
          done("Buy paint and rollers", 5), done("Tape and prep", 2), t("First coat", "doing"), t("Second coat"),
        ]),
        t("Install new cabinet handles", "todo", null, [], { due: -2 }),
        t("Under-cabinet lighting", "todo", null, [t("Measure the cabinets"), t("Order LED strips"), t("Install and wire")], { due: 6 }),
        t("Replace the faucet"),
        t("Re-seal the countertop"),
        ...history(["Remove old backsplash", "Choose paint colour", "Clear out the cabinets", "Get quotes from electricians", "Fix the leaking pipe", "Patch wall holes"], 9, 40, 23),
      ],
    },
    {
      id: "spanish", name: "Learn Spanish", description: "Thirty minutes a day, plus one bigger goal a month.", created: daysAgo(340),
      tasks: [
        { ...t("Practice session (30 min)", "todo", null, [], { repeat: daily }), waitUntil: daysAgo(-1), repeatFrom: lastPractice.id },
        t("Finish unit 4: the past tense", "doing", null, [
          done("Lesson 4.1", 4), done("Lesson 4.2", 2), t("Lesson 4.3", "doing"), t("Unit 4 quiz"),
        ]),
        t("Watch a film without subtitles"),
        t("Book a conversation class", "todo", null, [], { due: 0 }),
        ...practice,
        ...history(["Finish unit 1", "Finish unit 2", "Finish unit 3", "Read a short story", "Learn 100 new words", "Write a diary entry in Spanish"], 10, 300, 31, 8),
      ],
    },
    {
      id: "chores", name: "Home Chores", description: "", created: daysAgo(330),
      tasks: [
        t("Vacuum the house", "todo", null, [], { repeat: weekly }),
        t("Change the bed sheets", "todo", null, [], { repeat: { every: 2, unit: "week" } }),
        { ...t("Water the plants", "todo", null, [], { repeat: { every: 3, unit: "day" } }), waitUntil: daysAgo(-2), repeatFrom: "chores-water-last" },
        t("Clean the gutters", "todo", null, [], { repeat: { every: 6, unit: "month" } }),
        t("Sort out the garage shelf"),
        { ...done("Water the plants", 1), id: "chores-water-last", repeat: { every: 3, unit: "day" } },
        ...history(["Vacuum the house", "Laundry", "Take out the recycling", "Mow the lawn", "Clean the fridge", "Grocery run", "Change the bed sheets", "Water the plants"], 70, 320, 47),
      ],
    },
    {
      id: "photobook", name: "Photo Book: Summer Trip", description: "Turn the summer trip photos into a printed book.", created: daysAgo(30),
      tasks: [
        t("Pick the best 60 photos"),
        t("Colour-correct the picks"),
        t("Lay out the pages", "todo", null, [t("Cover"), t("Chapter: the coast"), t("Chapter: the mountains")]),
        t("Order a test print", "todo", null, [], { due: 20 }),
        done("Import photos from the camera", 26), done("Back up the originals", 25),
      ],
    },
    {
      id: "garage", name: "Garage Cleanup", description: "Done in the spring.", created: daysAgo(240), archived: true,
      tasks: history(["Sort tools", "Haul junk to the tip", "Install wall shelving", "Sweep and seal the floor", "Label storage boxes"], 8, 30, 59, 190),
    },
  ];
  return d;
}
