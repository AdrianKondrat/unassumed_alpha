# Founder Field Kit: waitlist lead magnets

Four fill-in PDF field sheets for first-time founders. Each one makes the reader *do* something in under 30 minutes, then ends on the one thing paper can't do: answer back. That is the gap Unassumed fills.

| File | What the founder does | Pages | Role |
|---|---|---|---|
| `pdf/01-leading-question-autopsy.pdf` | Learns the **Three Tells** (Leading · Hypothetical · Solution-biased), drills 12 questions, audits and rewrites their own script | 6 | **Flagship.** Gate it. |
| `pdf/02-the-canvas-interrogation.pdf` | Turns their business model canvas into falsifiable guesses, a kill list, an experiment map, plus 5 honest AI prompts | 6 | Second drop |
| `pdf/03-your-first-five-conversations.pdf` | Finds 10 people (warm first), sends 1 of 3 message templates, runs a 30-min run sheet, keeps a courage log | 6 | Second drop |
| `pdf/04-the-compliment-trap.pdf` | 10-min post-call debrief: sorts what they heard into compliment / fluff / fact / commitment | 3 | **Ungated taste.** Shareable. |
| `pdf/unassumed-founder-field-kit.pdf` | All four, bookmarked | 21 | The "full kit" |

Research behind every choice: `research-dossier.md` (6 independent expert passes, conflict map, briefing, hostile audit, verification).

## Rebuild

```bash
node lead-magnets/render.mjs            # all sheets
node lead-magnets/render.mjs 01-leading-question-autopsy   # one sheet
```

Sources are `src/*.html` with a shared `src/print.css`. They reuse the site's fonts from `public/fonts/` and the same colour tokens. The renderer uses the preinstalled Chromium through Playwright. After a rebuild, re-merge the kit PDF (the snippet is in this session's history, or use `qpdf --empty --pages pdf/0*.pdf -- pdf/unassumed-founder-field-kit.pdf`).

## Recommended launch (from the research)

1. **Week 1:** gate **01** and offer **04** ungated. Ungated means anyone can download it, with a link to 01 inside. Hold 02 and 03.
2. **Weeks 3–6:** release 02 and 03, or offer the full kit to accelerators and university enterprise societies. The sheets are "free to print and share", which suits cohort workshops.
3. **Delivery that keeps the "one email" promise:** serve the PDF instantly on `/thanks`, and link it in the confirmation email the Worker *already* sends (`src/email.ts`). Don't add a new email or a sequence.
4. **One optional qualifier field** on the form: *"Customer interviews so far: 0 / 1–5 / 6+"*. Drop it if it cuts opt-in by more than ~20% in two weeks.
5. **Measure the right thing:** compare kit-sourced and direct signups on *activation* (a first rehearsal in beta), not on downloads. The kit is failing if kit signups activate at under ~70–80% of the direct rate, or if beta users say "the sheet was enough".
6. **Screenshot-native sharing:** page 1 of sheet 01 (the before → after card) is the asset to post on LinkedIn and X. Founders share images more readily than PDFs, and many communities penalise link drops (check each subreddit's rules).

## Decisions only you can make

- **License.** The footer says "Free to print and share. Keep this footer." A formal Creative Commons license (e.g. CC BY-NC 4.0) would let incubators reprint it legally. That's your legal call.
- **Consent wording.** Check ICO guidance before attaching any *marketing* consent to the download, because bundled consent is a risk under UK GDPR and PECR.
- **Reply call-to-action.** Inviting "reply with your worst interview question" in the confirmation email is a strong qualifier, but only if someone answers within ~48h (budget 30–60 min/day).

## Content rules followed (from the audit)

- Every example is labelled illustrative. No testimonials and no invented statistics.
- Only research verified this session is printed, each with a caveat: Murphy et al. 2005, Webb & Sheeran 2006, Loftus & Palmer 1974, Guest et al. 2006 plus Hagaman & Wutich 2016, Camuffo et al. 2020 / SMJ 2024, and Bisbee et al. 2024.
- Deliberately **not** printed: "people overstate by 3×", "12 interviews is enough", Griffin & Hauser's "90%", vendor opt-in percentages, and the site's "11 conversations, 9 agree".
- The Mom Test, YC "How to Talk to Users", Strategyzer's Business Model Canvas (CC BY-SA) and Bland & Osterwalder's assumptions mapping are credited by name.
- "Three Tells" is Unassumed's own coinage. A search found no existing framework by that name.
