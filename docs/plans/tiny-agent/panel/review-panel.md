# Review panel (approved by Harper 2026-08-30)

Each reviewer evaluates ALL four variants and force-ranks them.

1. **Cass, cold code reader** — source only, no running. Philosophy adherence,
   error-handling honesty, test quality, claimed-vs-actual LOC.
2. **Piper, first-run user** — lands cold in each worktree; can she run it from what's
   committed? Friction and confusion, subjective.
3. **Otto, operator** — runs each variant live on two unseen tasks (small refactor +
   one hostile task). Completion, turns, tokens, failure legibility.
4. **Nadia, hacker** — attempts a real small modification per variant (add list_files
   tool, swap system prompt), counts touched lines, judges hack-feel. Weighted heavily:
   the product IS a playground.

Elimination: fails own tests → out. Critical operator failure → out.
Every reviewer must report per-variant STRENGTHS (synthesis fuel), not just flaws.
