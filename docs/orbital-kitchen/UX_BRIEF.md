# Orbital Kitchen — "Feels Good" UX Brief

> Distilled from the design handoff (`Orbital - Synopsis & Proposals.html`, `Design Playbook.html`,
> `User Journeys.html`, `colors_and_type.css`, `Orbital Kitchen.html`). This is the acceptance bar for
> the cutover: it must not just look good, it must **feel** good. Grade every wave against §6.

## 1 · North star
**One operator calmly trusting many autonomous agents — hands-free.** Like a head chef running a busy
line through an expediter: call out orders + approvals while barely looking; the Chef de Cuisine
(Janus) keeps the swarm productive. Air-traffic-control wearing a chef's hat — the warmth exists so a
single person can trust an autonomous system at a glance and step away.

## 2 · Core principles
1. **If you can click it, you can say it.** Voice is a first-class peer, never a follow-up. Every
   actionable surface ships a spoken call + appears in "what're my calls?". Mouse-only = #1 anti-pattern.
2. **Every action declares its gate.** Nothing touches a pane without a tunable Auto/Ask/Off gate
   ("let 'em cook" / "taste every plate" / "not in my kitchen"), visible in the Rulebook. New things
   default to the *safest sensible* gate — never Auto for state mutations.
3. **Glance-able before detailed.** State reads in <1s from across the room: color, motion, one literal
   word. Detail is a click/question away, never the default load.
4. **Calm scales; chaos is seasoning.** Calm-first. Whimsy (mascots, dance, scribbles) is opt-in delight
   confined to the live Line — NEVER the Pantry or Back of House.
5. **Keep the machine legible.** Costume never hides truth: literal status (Running/Idle/Needs Input/
   Exited), settings mirror real config, real IDs/paths shown.
6. **Structure left, action right, the moment in the middle.** Left = where (projects/nav), center =
   what's happening (Line + Pass on top), right = what I do next (active pane cockpit + voice + approvals).
7. **Speak the consequence, confirm out loud.** Risky actions get a spoken read-back before firing;
   every action produces an audible+visible ack ("Order up!") and narrates into the Kitchen Radio
   (the session's source of truth). Low-risk + Full Auto skips the read-back.
8. **Earn trust, don't configure it.** "You've approved this 10×, want it on Auto?" beats a buried toggle.

## 3 · Key journeys (how they should FEEL)
- **Open the kitchen:** mic → Janus greets/reports → pick project → "fire up a claude pane on auth" ×3
  → dictate orders → "taste every plate" → step back. *Clock in + delegate a shift in <1 min, by voice.*
- **Run the line eyes-off:** ambient narration → earcon ding + read-back ("Payments needs a taste —
  run the migration?") → "fire it" → "Order up." *A sous-chef calling you only when it matters.*
- **Call the pass (triage):** "what's on the pass?" → "stitch that bug to Payments" (→ bead) → "open a
  pane on it" → dictate fix → "fire it · mark it served." *A loose note becoming live work, frictionless.*
- **Adjust autonomy:** "what's auth about to do?" → "make auth taste every plate" → "no clearing history
  kitchen-wide" → "let docs cook." *A dial you turn mid-service, station by station.*
- **All Hands:** "ALL HANDS — stop the line!" → freeze/cancel in-flight (stage 1) → "kill the burners"
  hold-to-kill (stage 2) → "Gas is off." → "back to service." *Decisive, reversible brake.*

## 4 · Micro-interaction / polish cues
- **Earcons + spoken acks:** bell ding for Needs Input (🛎), "Order up! 🍽" on success. Eyes-off ⇒ quiet
  state changes are forbidden.
- **Motion:** hard *offset sticker shadows* (never blurred), bouncy ease `cubic-bezier(.34,1.56,.64,1)`;
  buttons lift on hover, *flatten on press* (`translate(2px,2px); box-shadow:none`); tilts only −2°→+1.2°.
- **Live-feel:** candy-stripe "working" spine on running panes, active pane *ringed*, exited *dimmed*,
  per-card activity sparkline; burner streams type-on with a real cursor + ANSI color.
- **Mascots as empathy:** one at a time, Line-only — idle foot-tap, running while agents work, *wink* on
  a new ticket, *panic* on the brake, shimmy on "Order up." Tappable joy, gated behind a tweak.
- **Copy — line cook with a smirk:** verbs first ("Fire up a pane," "86 that"), contractions, "Chef".
  Emoji is spice not decoration: 🔥 priority, 🛎 awaiting, 🍽 served. Empty states: "nothin' cookin' 😴."
  Scribbles (Caveat, tilted, quoted) are ephemeral asides, never load-bearing data.
- **Tokens only:** cream `#fff4de`, ink `#2a1a10`, Fraunces/DM Sans/JetBrains Mono/Caveat.

## 5 · Anti-patterns
Mouse-only power · silent autonomy (act with nothing said/shown) · whimsy in the calm (dancing chefs in
BoH; scribbles holding real data) · costume over machine (hiding literal status/command/config) · a new
home for everything (settings on the Line, nav in the rail) · config-first trust. Always-allowed actions
(stop/release) must keep working even when frozen.

## 6 · "Feels good" acceptance checklist
1. Every action I can click, I can also *say* — and it's in "what're my calls?".
2. Risky actions speak a read-back + confirm by voice; low-risk + Full Auto skips it.
3. Every action → audible + visible ack, landing in the Kitchen Radio transcript.
4. Any pane's state reads in <1s from color/motion/one literal word, across the room.
5. The Line feels alive: streaming terminal, candy-stripe spine, ringed active pane, dimmed exits, mascots.
6. The Pantry + Back of House are CALM — zero mascots/scribbles; whimsy is opt-in + Line-only.
7. All Hands freezes instantly, reversible before stage-2 kill, stop/release work while frozen.
8. Buttons lift/flatten with sticker-shadow + bounce; degrades under reduced-motion, dark mode, freeze.
9. Copy is kitchen voice; status/IDs/paths literal; settings mirror real config.
10. Autonomy grantable in-flow ("approved 10× — go Auto?"); each gate visible in the Rulebook; nothing
    mutates state on Auto by default.
