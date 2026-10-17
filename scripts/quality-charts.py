#!/usr/bin/env python3
"""Draws the five figures in docs/quality-strategy.md from what the calculator worked out.

Run scripts/quality-charts.mjs first; it writes docs/images/quality-strategy.json and this
reads it. Nothing is computed here on purpose — a chart that does its own arithmetic is a
second source of truth, and the point of these is that they say exactly what the tab says.

Needs matplotlib and pillow, which are the only Python in this repository:

    npm run charts
"""
import json
import os

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGES = os.path.join(ROOT, 'docs', 'images')
D = json.load(open(os.path.join(IMAGES, 'quality-strategy.json')))
RACE = json.load(open(os.path.join(IMAGES, 'quality-race.json')))

# The studio's own palette, so the figures look like the thing that produced them.
BG, LINE, TEXT, DIM, ACCENT = '#14171c', '#2c333d', '#d7dce3', '#8b95a3', '#ffae3f'
COLD, MID, GREY = '#6f8fd0', '#7ec98f', '#5d6673'
# One colour per setup, kept the same across every figure so a line and a bar are the same run.
RAMP = ['#d06f6f', '#a883d6', '#6f8fd0', '#7ec98f', '#ffae3f']

plt.rcParams.update({
    'figure.facecolor': BG, 'axes.facecolor': BG, 'savefig.facecolor': BG,
    'text.color': TEXT, 'axes.labelcolor': TEXT, 'xtick.color': DIM, 'ytick.color': DIM,
    'axes.edgecolor': LINE, 'grid.color': LINE, 'font.family': 'DejaVu Sans', 'font.size': 11,
    'axes.titlesize': 14, 'axes.titleweight': 'bold', 'figure.dpi': 160,
})

KEYS = [s['key'] for s in D['setups']]
LABELS = {s['key']: s['label'] for s in D['setups']}
TARGETS = D['targets']


def frame(ax):
    for side in ('top', 'right'):
        ax.spines[side].set_visible(False)
    ax.grid(True, lw=0.6, alpha=0.5)
    ax.set_axisbelow(True)


def num(value):
    return f'{value:,.0f}'.replace(',', ' ') if value >= 100 else f'{value:.1f}'


def save(fig, name):
    """Flat colours quantise to a palette with no visible loss and a quarter of the bytes."""
    path = os.path.join(IMAGES, name)
    fig.savefig(path)
    plt.close(fig)
    Image.open(path).convert('RGB').quantize(colors=128, method=Image.MEDIANCUT).save(path, optimize=True)
    return name


# ── 1. What one legendary circuit costs ───────────────────────────────────────
fig, (left, right) = plt.subplots(1, 2, figsize=(13, 5.6))
cost = [D['cost'][k]['legendary'] for k in KEYS]
machines = [D['machines'][k]['legendary'] for k in KEYS]
names = [LABELS[k] for k in KEYS]

for ax, values, title, unit in (
    (left, cost, 'Materials', 'sets of ingredients per circuit'),
    (right, machines, 'Machines', 'assemblers + recyclers per circuit a minute'),
):
    bars = ax.barh(names, values, color=RAMP, height=0.62)
    ax.set_xscale('log')
    ax.set_title(title, loc='left', pad=12)
    ax.set_xlabel(unit, color=DIM, fontsize=10)
    ax.invert_yaxis()
    frame(ax)
    for bar, value in zip(bars, values):
        ax.text(value * 1.25, bar.get_y() + bar.get_height() / 2, num(value), va='center',
                color=TEXT, fontsize=11, fontweight='bold')
    ax.set_xlim(min(values) * 0.4, max(values) * 6)

fig.text(0.02, 0.965, 'What one legendary electronic circuit costs', va='top', fontsize=17, fontweight='bold')
# Said by the data rather than typed in, so the sentence cannot drift away from the bars.
fig.text(0.02, 0.885, f'From quality 1 modules to legendary quality 3: {cost[0] / cost[-1]:.0f}× cheaper in materials, '
                      f'{machines[0] / machines[-1]:.0f}× in machines.\nLog scale — every gridline is another factor of ten.',
         va='top', color=DIM, fontsize=10.5)
fig.tight_layout(rect=[0, 0, 1, 0.78])
print(save(fig, 'quality-cost-of-one-legendary.png'))

# ── 2. How far up it is worth going, on which modules ─────────────────────────
fig, ax = plt.subplots(figsize=(11, 6))
for key, colour in zip(KEYS, RAMP):
    ys = [D['cost'][key][t] for t in TARGETS]
    ax.plot(range(len(ys)), ys, marker='o', lw=2.2, ms=7, color=colour, label=LABELS[key])
    ax.annotate(num(ys[-1]), (len(ys) - 1, ys[-1]), textcoords='offset points', xytext=(10, -4),
                color=colour, fontsize=10.5, fontweight='bold')
ax.set_yscale('log')
ax.set_xticks(range(len(TARGETS)))
ax.set_xticklabels(TARGETS)
ax.set_ylabel('sets of ingredients per item', color=DIM, fontsize=10)
ax.set_xlim(-0.25, len(TARGETS) - 0.55)
ax.axhspan(1, 100, color=MID, alpha=0.06)
ax.text(0.02, 55, 'under a hundred sets — affordable', color=MID, fontsize=10)
frame(ax)
ax.legend(frameon=False, labelcolor=TEXT, fontsize=10.5, loc='upper left')
ax.set_title('How far up the ladder is worth going, on which modules', loc='left', pad=14)
fig.text(0.008, 0.015, 'Uncommon and rare are cheap even on early modules. Legendary on quality 1 modules is '
                       'thirteen and a half thousand sets for one circuit.', color=DIM, fontsize=10, va='bottom')
fig.tight_layout(rect=[0, 0.06, 1, 1])
print(save(fig, 'quality-cost-by-tier.png'))

# ── 3. What the recycler is worth ─────────────────────────────────────────────
fig, ax = plt.subplots(figsize=(11, 6))
width = 0.26
kinds = [('none', 'no recycler at all — the roll on its own', GREY),
         ('bare', 'a recycler with nothing in it', COLD),
         ('full', 'a recycler with the same modules', ACCENT)]
for i, (kind, label, colour) in enumerate(kinds):
    ys = [D['loop']['q3em'][t][kind] for t in TARGETS]
    xs = [x + (i - 1) * width for x in range(len(TARGETS))]
    ax.bar(xs, ys, width=width, color=colour, label=label)
    for x, value in zip(xs, ys):
        ax.text(x, value * 1.18, num(value), ha='center', color=TEXT, fontsize=9.5)
ax.set_yscale('log')
ax.set_ylim(top=D['loop']['q3em']['legendary']['none'] * 12)
ax.set_xticks(range(len(TARGETS)))
ax.set_xticklabels(TARGETS)
ax.set_ylabel('sets of ingredients per item', color=DIM, fontsize=10)
frame(ax)
ax.legend(frameon=False, labelcolor=TEXT, fontsize=10.5, loc='upper left')
ax.set_title('What the loop is worth — quality 3 in an EM plant, a 12.5% roll', loc='left', pad=14)
fig.text(0.008, 0.015, 'The higher the tier, the more the loop does: twice over at uncommon, twenty-five times at legendary.\n'
                       'Before Fulgora there is no recycler at all — that is the grey bar.', color=DIM, fontsize=10, va='bottom')
fig.tight_layout(rect=[0, 0.085, 1, 1])
print(save(fig, 'quality-what-the-loop-gives.png'))

# ── 4. The farm as a tax on the factory ───────────────────────────────────────
BELT = 1800.0  # an express belt, items a minute
fig, (left, right) = plt.subplots(1, 2, figsize=(13.5, 5.8))
farms = [D['farm']['q3em'], D['farm']['q3L']]
names = [f['label'] for f in farms]
iron = [f['ingredients']['iron-plate'] / BELT for f in farms]
cable = [f['ingredients']['copper-cable'] / BELT for f in farms]
rows = range(len(names))

left.barh([y + 0.17 for y in rows], iron, height=0.3, color='#9aa7b8', label='iron plates')
left.barh([y - 0.17 for y in rows], cable, height=0.3, color='#c98a4b', label='copper cable')
for y, value in zip(rows, iron):
    left.text(value + 0.35, y + 0.17, f'{value:.1f} belts  ({num(value * BELT)}/min)', va='center', color=TEXT, fontsize=10)
for y, value in zip(rows, cable):
    left.text(value + 0.35, y - 0.17, f'{value:.1f} belts  ({num(value * BELT)}/min)', va='center', color=TEXT, fontsize=10)
left.set_yticks(list(rows))
left.set_yticklabels(names)
left.invert_yaxis()
left.set_xlabel('express belts of input', color=DIM, fontsize=10)
left.set_xlim(0, max(cable) * 1.75)
left.set_title('What it eats', loc='left', pad=12)
left.legend(frameon=False, labelcolor=TEXT, fontsize=10, loc='lower right')
frame(left)

crafters = [f['crafters'] for f in farms]
recyclers = [f['recyclers'] for f in farms]
right.barh([y + 0.17 for y in rows], crafters, height=0.3, color=MID, label='assemblers')
right.barh([y - 0.17 for y in rows], recyclers, height=0.3, color=COLD, label='recyclers')
for y, value in zip(rows, crafters):
    right.text(value + 3, y + 0.17, f'{value:.0f}', va='center', color=TEXT, fontsize=10.5, fontweight='bold')
for y, value in zip(rows, recyclers):
    right.text(value + 3, y - 0.17, f'{value:.0f}', va='center', color=TEXT, fontsize=10.5, fontweight='bold')
right.set_yticks(list(rows))
right.set_yticklabels(['', ''])
right.invert_yaxis()
right.set_xlabel('machines', color=DIM, fontsize=10)
right.set_xlim(0, max(crafters) * 1.25)
right.set_title('What it costs to stand up', loc='left', pad=12)
right.legend(frameon=False, labelcolor=TEXT, fontsize=10, loc='lower right')
frame(right)

fig.text(0.02, 0.965, 'Sixty legendary circuits a minute is a tax on the whole factory', va='top', fontsize=17, fontweight='bold')
fig.text(0.02, 0.885, f'One express belt is 1800 items a minute. On ordinary quality 3 modules the farm eats '
                      f'{iron[0] + cable[0]:.0f} belts of feed — a finished factory,\nnot an extension to one. On legendary modules it is '
                      f'{iron[1] + cable[1]:.0f} belts.', va='top', color=DIM, fontsize=10.5)
fig.tight_layout(rect=[0, 0, 1, 0.78])
print(save(fig, 'quality-farm-as-a-tax.png'))

# ── 5. The other route: a chain with modules in every machine ─────────────────
fig, ax = plt.subplots(figsize=(11, 6))
ramp = ['#d06f6f', '#a883d6', '#6f8fd0', '#7ec98f', ACCENT]
for run, colour in zip(D['chain'], ramp):
    ys = [share * 100 for share in run['legendary']]
    ax.plot(D['chainSteps'], ys, marker='o', lw=2.2, ms=7, color=colour,
            label=f"{run['label']} — {run['chance'] * 100:.3g}% a step")
    ax.annotate(f'{ys[-1]:.2f}%', (D['chainSteps'][-1], ys[-1]), textcoords='offset points',
                xytext=(10, -4), color=colour, fontsize=10.5, fontweight='bold')
ax.set_yscale('log')
ax.set_xlabel('machines in the chain, each with quality modules', color=DIM, fontsize=10)
ax.set_ylabel('share of the output that is legendary, %', color=DIM, fontsize=10)
ax.set_xlim(0.85, len(D['chainSteps']) + 0.75)
frame(ax)
ax.legend(frameon=False, labelcolor=TEXT, fontsize=10.5, loc='upper left')
ax.set_title('The other route: quality all the way down the chain, no recycler at all', loc='left', pad=14)
fig.text(0.008, 0.015, 'Quality carries through a craft, so every machine in a chain is another roll on the same material and the shares compound.\n'
                       'Six steps on legendary modules turn 14% of the output legendary; the same six steps on ordinary quality 3 modules turn 1.4%.',
         color=DIM, fontsize=10, va='bottom')
fig.tight_layout(rect=[0, 0.085, 1, 1])
print(save(fig, 'quality-chain-instead-of-a-loop.png'))

# ── 6. Quality machines against simply building more ──────────────────────────
fig, ax = plt.subplots(figsize=(11, 5.6))
tier_names = ['normal', 'uncommon', 'rare', 'epic', 'legendary']
width = 0.36
for i, (key, label, colour) in enumerate((('q1', 'on quality 1 modules', '#d06f6f'),
                                          ('q3L', 'on legendary quality 3 modules', ACCENT))):
    ys = D['perMaterial'][key]
    xs = [x + (i - 0.5) * width for x in range(len(tier_names))]
    ax.bar(xs, ys, width=width, color=colour, label=label)
    for x, value in zip(xs, ys):
        ax.text(x, value * 1.35, f'{value:.2g}', ha='center', color=TEXT, fontsize=9.5)
ax.axhline(1, color=MID, lw=1.4, ls='--')
# Both ends stated: a log axis given only a top puts the bottom somewhere useless and every
# bar comes out full height. The headroom is for the legend and the line's label.
floor = min(v for key in ('q1', 'q3L') for v in D['perMaterial'][key] if v > 0)
ax.set_ylim(floor / 3, 12)
ax.text(len(tier_names) - 0.55, 1.6, 'building more ordinary machines', color=MID, fontsize=10, ha='right')
ax.set_yscale('log')
ax.set_xticks(range(len(tier_names)))
ax.set_xticklabels(tier_names)
ax.set_ylabel('throughput bought per unit of material', color=DIM, fontsize=10)
frame(ax)
ax.legend(frameon=False, labelcolor=TEXT, fontsize=10.5, loc='upper left')
ax.set_title('Quality machines are not a way to grow a factory', loc='left', pad=14)
fig.text(0.008, 0.015, 'An assembling machine 3 goes from 1.25 to 3.125 by the top tier: two and a half times the speed for thirty times the materials,\n'
                       'so the same materials spent on ordinary machines buy twelve times the throughput. Quality pays where space, power or beacons are the limit.',
         color=DIM, fontsize=10, va='bottom')
fig.tight_layout(rect=[0, 0.085, 1, 1])
print(save(fig, 'quality-machines-vs-more-machines.png'))

# ── 7. The two players, on one clock ──────────────────────────────────────────
series = RACE['series']
hours = [row['t'] for row in series]
gate_a, gate_b = RACE['gateA'], RACE['gateB']
A_COLOUR, B_COLOUR = '#d06f6f', ACCENT

fig, (left, right) = plt.subplots(1, 2, figsize=(13.5, 5.8))

left.plot(hours, [row['factoryB'] for row in series], lw=2.4, color=B_COLOUR, label='B · scale first, convert late')
left.plot(hours, [row['factoryA'] for row in series], lw=2.4, color=A_COLOUR, label='A · quality from the start')
left.set_yscale('log')
left.set_title('The factory', loc='left', pad=12)
left.set_xlabel('hours', color=DIM, fontsize=10)
left.set_ylabel('output an hour', color=DIM, fontsize=10)
frame(left)
left.legend(frameon=False, labelcolor=TEXT, fontsize=10, loc='upper left')
gap = series[-1]['factoryB'] / series[-1]['factoryA']
left.annotate(f'{gap:.1f}× apart by the gate,\nand parallel after it',
              (hours[-1], series[-1]['factoryA']), textcoords='offset points', xytext=(-118, -78),
              color=DIM, fontsize=10)

for ax in (left, right):
    for gate, colour, name in ((gate_b, B_COLOUR, 'B opens legendary'), (gate_a, A_COLOUR, 'A opens legendary')):
        ax.axvline(gate, color=colour, lw=1.2, ls=':', alpha=0.8)

right.plot(hours, [row['rateB'] for row in series], lw=2.4, color=B_COLOUR)
right.plot(hours, [row['rateA'] for row in series], lw=2.4, color=A_COLOUR)
right.set_yscale('log')
right.set_ylim(bottom=1e-2)
# Zoomed to the gate: the whole race for legendary items happens in the last quarter of the
# run, and at full width the takeoff is a vertical line against a hundred empty hours.
right.set_xlim(gate_b - 15, hours[-1])
right.set_title('Legendary items a minute', loc='left', pad=12)
right.set_xlabel('hours', color=DIM, fontsize=10)
frame(right)
right.annotate(f'B opens the tier\nat {gate_b:.0f} h', (gate_b, 1.3e-2), textcoords='offset points', xytext=(-96, 44),
               color=B_COLOUR, fontsize=10)
right.annotate(f'A, {gate_a - gate_b:.0f} h later', (gate_a, 1.3e-2), textcoords='offset points', xytext=(10, 78),
               color=A_COLOUR, fontsize=10)
right.annotate(f"after {hours[-1]:.0f} h: {series[-1]['totalB']:,.0f} legendary items to B, {series[-1]['totalA']:,.0f} to A".replace(',', ' '),
               (hours[-1], 1.3e-2), textcoords='offset points', xytext=(-352, 4),
               color=DIM, fontsize=10)

fig.text(0.02, 0.965, 'Two players, one clock', va='top', fontsize=17, fontweight='bold')
fig.text(0.02, 0.885,
         f'A puts quality modules in everything from the first one researched; B ignores quality until the legendary tier and then converts.\n'
         f'B reaches the gate {gate_a - gate_b:.0f} hours earlier with a {gap:.1f}× bigger factory, and after it both grow at the same rate — so the gap never closes.',
         va='top', color=DIM, fontsize=10.5)
fig.tight_layout(rect=[0, 0, 1, 0.78])
print(save(fig, 'quality-two-players.png'))

# ── 8. What each step of quality needs before it exists ───────────────────────
SHORT = {
    'automation-science-pack': 'red', 'logistic-science-pack': 'green', 'military-science-pack': 'military',
    'chemical-science-pack': 'blue', 'production-science-pack': 'purple', 'utility-science-pack': 'yellow',
    'space-science-pack': 'space', 'metallurgic-science-pack': 'metallurgic\n(Vulcanus)',
    'agricultural-science-pack': 'agricultural\n(Gleba)', 'electromagnetic-science-pack': 'electromagnetic\n(Fulgora)',
    'cryogenic-science-pack': 'cryogenic\n(Aquilo)', 'promethium-science-pack': 'promethium',
}
used = [p for p in D['packs'] if any(p in needs for _, needs in D['unlocks'])]
fig, ax = plt.subplots(figsize=(12.5, 4.8))
for row, (name, needs) in enumerate(D['unlocks']):
    for col, pack in enumerate(used):
        on = pack in needs
        ax.scatter(col, row, s=210, zorder=3, color=ACCENT if on else '#232830',
                   edgecolors=ACCENT if on else LINE, linewidths=1)
    ax.text(len(used) - 0.55, row, f'{len(needs)} packs', va='center', color=DIM, fontsize=10)
ax.set_xticks(range(len(used)))
ax.set_xticklabels([SHORT[p] for p in used], fontsize=9.5)
ax.set_yticks(range(len(D['unlocks'])))
ax.set_yticklabels([name for name, _ in D['unlocks']], fontsize=11)
ax.set_xlim(-0.6, len(used) + 0.6)
ax.set_ylim(len(D['unlocks']) - 0.4, -0.6)
ax.grid(True, lw=0.5, alpha=0.35)
ax.set_axisbelow(True)
for side in ('top', 'right', 'left', 'bottom'):
    ax.spines[side].set_visible(False)
ax.tick_params(length=0)
ax.set_title('What each step of quality needs first — from the dataset\'s own technologies', loc='left', pad=14)
fig.text(0.008, 0.02, 'The legendary tier opens only after all four planets. Quality 3 modules come with Fulgora, and so does the recycler.',
         color=DIM, fontsize=10)
fig.tight_layout(rect=[0, 0.05, 1, 1])
print(save(fig, 'quality-what-unlocks-when.png'))
