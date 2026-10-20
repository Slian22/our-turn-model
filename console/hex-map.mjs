/** Original SVG atlas for synthetic regional scenarios. No browser or asset dependencies.
 * Positive link.flow is from → to; negative flow reverses that direction.
 * The caller delegates click and Enter/Space activation via [data-region].
 */
const NS = 'http://www.w3.org/2000/svg';
const MODES = ['adequacy', 'power', 'compute'];
const PALETTE = ['#ead6ae', '#8ac8ad', '#508c8a', '#20575e'];
const R = 142, Y = .72, DX = Math.sqrt(3) * R;
let instance = 0;
const mounts = new WeakMap();
const PROJECTS = [['hardware', 'Compute', 'blocks'], ['power', 'Power', 'TWh/year'], ['factory', 'Fabrication', 'blocks/year'], ['powerAutomation', 'Power automation', 'fraction'], ['fabAutomation', 'Fab automation', 'fraction']];
// XML 1.0 forbids controls, noncharacters U+FFFE/FFFF and isolated UTF-16
// surrogates. Unicode mode preserves valid astral pairs; model labels stay intact.
const esc = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\ud800-\udfff]/gu,'�')
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0;
const number = value => !finite(value) ? 'unavailable' : value !== 0 && Math.abs(value) < .01
  ? value.toExponential(2).replace('e+', 'e') : Math.abs(value) >= 1e7
  ? value.toExponential(2).replace('e+', 'e') : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = value => nonnegative(value) ? `${number(value * 100)}%` : 'unavailable';
const modeOf = mode => MODES.includes(mode) ? mode : 'adequacy';
const short = (value, limit = 23) => {
  const chars = Array.from(String(value ?? 'Unnamed region'));
  return esc(chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : chars.join(''));
};
const p = value => Number(value.toFixed(2));
const xy = (q, r, scale = 1) => ({ x: p(720 + DX * (q + r / 2) * scale), y: p(433 + R * 1.5 * Y * r * scale) });
const points = (radius = R, offset = 0) => Array.from({ length: 6 }, (_, i) => {
  const angle = (i * 60 - 90) * Math.PI / 180;
  return `${p(radius * Math.cos(angle))},${p(radius * Math.sin(angle) * Y + offset)}`;
}).join(' ');
const text = (x, y, content, cls = '', extra = '') => `<text x="${x}" y="${y}" class="${cls}" ${extra}>${esc(content)}</text>`;
const use = (id, symbol, x, y, scale = 1) => `<use href="#${id}-${symbol}" transform="translate(${x} ${y}) scale(${scale})"/>`;

function definitions(id) {
  return `<defs>
    <linearGradient id="${id}-sea" x2="0" y2="1"><stop stop-color="#244b57"/><stop offset="1" stop-color="#122e3b"/></linearGradient>
    <pattern id="${id}-waves" width="60" height="36" patternUnits="userSpaceOnUse"><path d="M4 18q9-5 18 0t18 0" fill="none" stroke="#78a3a4" stroke-opacity=".16" stroke-width="1"/></pattern>
    <pattern id="${id}-grain" width="11" height="11" patternUnits="userSpaceOnUse"><path d="M1 3h1m5 5h1" stroke="#314b46" stroke-opacity=".12"/></pattern>
    <clipPath id="${id}-map"><rect x="20" y="100" width="1400" height="674" rx="8"/></clipPath>
    <marker id="${id}-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1l8 4-8 4" fill="none" stroke="#fff1c9" stroke-width="1.8"/></marker>
    <g id="${id}-tree"><path d="M-2-12h4V3h-4z" fill="#574f3e"/><path d="M0-37l12 20H7l8 12H-15l8-12h-5z" fill="#315e52"/><path d="M0-37v32h15L7-17h5z" fill="#244b47"/></g>
    <g id="${id}-hill"><path d="M-44 4L-12-44 5-23 18-48 46 4z" fill="#8a9b8d"/><path d="M-12-44L-2 4h-42zm30-4L25 4h21z" fill="#667e76"/><path d="M-12-44l-9 14 9-3 8 6zm30-4L8-31l10-4 7 6z" fill="#e4dfc7"/></g>
    <g id="${id}-farm"><path d="M-36 0L0-18 36 0 0 20z" fill="#c6ae70" stroke="#a18d5c"/><path d="M-27 4L9-14m-18 27L27-5m-45 14L18-9M0 17L32 1" stroke="#657b56" stroke-width="4"/><path d="M-36 0L0 20 36 0" fill="none" stroke="#e6d39c" stroke-width="2"/></g>
    <g id="${id}-city"><path d="M-42-2L0-23 42-2 0 18z" fill="#bda57d"/><path d="M-29-10v-29l17-9 17 9v29L-12 0z" fill="#e8d9b5"/><path d="M-12-48l17 9v29L-12 0z" fill="#9e9e88"/><path d="M-29-39l17-13L5-39l-17 8z" fill="#385f5b"/><path d="M5-5v-43l13-7 14 7v43l-14 8z" fill="#d5c9a6"/><path d="M18-55l14 7v43L18 3z" fill="#81958a"/><path d="M5-48l13-14 14 14-14 7z" fill="#2d5152"/><path d="M-24-28v8m7-12v8M10-38v7m0 8v7m13-25v7m0 8v7" stroke="#5c7369" stroke-width="3"/></g>
    <g id="${id}-factory"><path d="M-36-2L0 16 36-2 0-20z" fill="#a7a68d"/><path d="M-31-7v-23l14 6v-13l16 7v-13l28 14v22L0 8z" fill="#5d7973"/><path d="M0-43l27 14v22L0 8z" fill="#385953"/><path d="M15-34v-25h8v29z" fill="#d3b887"/><path d="M-24-21v8m12-10v15m20-12v8m10-13v8" stroke="#e4c78f" stroke-width="3"/></g>
    <g id="${id}-power"><path d="M-29 0L0 14 29 0 0-14z" fill="#b3ad89"/><path d="M-15-2L-6-53H6L15-2M-21-36h42M-15-49h30M-10-22h20M-13-3L7-39M13-3L-7-39" fill="none" stroke="#3d625b" stroke-width="3"/><path d="M-7-53L0-63l7 10" fill="none" stroke="#3d625b" stroke-width="3"/><path d="M-23-35v9m46-9v9" stroke="#e0be78" stroke-width="3"/></g>
    <g id="${id}-compute"><path d="M-30 0L0 16 30 0 0-16z" fill="#a8a88b"/><path d="M-25-3v-24L0-37l25 10v24L0 9z" fill="#46676a"/><path d="M0-37l25 10v24L0 9z" fill="#2b4a53"/><path d="M-19-23l13-5m-13 12 13-5m-13 12 13-5m14-12 11 5M8-14l11 5" stroke="#a8d3c6" stroke-width="2"/></g>
    <g id="${id}-hall"><path d="M-30 0L0 16 30 0V-23L0-39-30-23z" fill="#526a6a" stroke="#203d42"/><path d="M0-8V16L30 0V-23z" fill="#263f4b"/><path d="M-30-23L0-8 30-23 0-39z" fill="#8caaa0"/><path d="M-22-28l23 12m-14-17 23 12" stroke="#38555c" stroke-width="3"/><path class="compute-lights" d="M-23-14l16 8m-16-1 16 8M7-7l15-8M7 1l15-8"/></g>
    <g id="${id}-campus"><path d="M-35 1L0 19 36 1 0-16z" fill="#728579"/>${use(id, 'hall', -14, -3, .72)}${use(id, 'hall', 16, -15, .72)}</g>
    <g id="${id}-complex"><path d="M-37 1L0 20 37 1 0-18z" fill="#728579"/>${use(id, 'hall', -18, 0, .65)}<path d="M-4 6v-54L14-58 32-49V-5L14 14z" fill="#507075"/><path d="M14-58l18 9V-5L14 14z" fill="#233f4b"/><path d="M-4-48l18 10 18-11-18-9z" fill="#a0b5a3"/><path class="compute-lights" d="M1-34l8 4m-8 5 8 4m-8 5 8 4m11-23 7-4m-7 13 7-4m-7 13 7-4"/></g>
    <g id="${id}-shore-house"><path d="M-34 6L16-19 39-7-12 19z" fill="#8d8768"/><path d="M-16 0v-24L1-33 18-24V0L1 9z" fill="#dbccaa"/><path d="M1-33l17 9V0L1 9z" fill="#85978a"/><path d="M-22-24L1-40 24-24 1-12z" fill="#38676b"/><path d="M-33 5v14m15-6v14m15-20v13" stroke="#71664f" stroke-width="3"/></g>
    <g id="${id}-mesa"><path d="M-58 8L-36-25 5-37 47-18 57 9 5 32z" fill="#9d997d"/><path d="M-36-25L5-37 47-18 6 5z" fill="#c7c39c"/><path d="M6 5v27l51-23-10-27z" fill="#788778"/><path d="M-44-10L6 16 50-6M-50 0L6 26" fill="none" stroke="#746f5c" stroke-opacity=".45"/></g>
    <g id="${id}-crane"><path d="M-9 17V-21H-4V17M-18-18H25L-6-28-18-18M-15 17H3M18-18V-1" fill="none" stroke="#edc880" stroke-width="2"/><path class="crane-hook" d="M18-2v6q0 4-4 2" fill="none" stroke="#fff1c9" stroke-width="2"/></g>
  </defs>`;
}

function styles() {
  return `<style>
    .hex-atlas{display:block;width:100%;height:auto;color:#eee0bd;background:#17292d;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .hex-atlas text{pointer-events:none}.hex-atlas .serif{font-family:Georgia,"Times New Roman",serif}
    .hex-atlas .eyebrow{font-size:11px;letter-spacing:2.4px;fill:#a8c3be;font-weight:650}
    .hex-atlas .title{font-size:30px;letter-spacing:1.4px;fill:#f1e1b9}
    .hex-atlas .muted{font-size:12px;fill:#adc2bc}.hex-atlas .small{font-size:11px;fill:#b8cbc3}
    .hex-atlas .region{cursor:pointer;outline:none}.hex-atlas .region-surface{stroke:#eddbad;stroke-width:1.5}
    .hex-atlas .region:hover .region-surface{stroke:#fff6d3;stroke-width:3}
    .hex-atlas .focus-ring{opacity:0;fill:none;stroke:#fff7da;stroke-width:4;stroke-dasharray:8 5;pointer-events:none}
    .hex-atlas .region:focus-visible .focus-ring{opacity:1}.hex-atlas .selection-ring{fill:none;stroke:#ffe0a0;stroke-width:3.5;pointer-events:none}
    .hex-atlas .region-name{font-size:15px;font-weight:700;fill:#f3e5c3;letter-spacing:.25px}
    .hex-atlas .metric{font-size:21px;font-weight:650;fill:#f9ebc9;font-variant-numeric:tabular-nums}
    .hex-atlas .detail{font-size:9px;fill:#b8cdc2}.hex-atlas .link-label{font-size:10px;fill:#ffebba;font-weight:600;font-variant-numeric:tabular-nums}
    .hex-atlas .link-track{fill:none;stroke:#a4b3a5;stroke-opacity:.58;stroke-linecap:round}
    .hex-atlas .link-flow{fill:none;stroke:#fff1c9;stroke-linecap:round}.hex-atlas .legend-label{font-size:11px;fill:#d6dfcc}
    .hex-atlas:not([data-overlay=power]) .link-label-panel{display:none}
    .hex-atlas .compute-lights{fill:none;stroke:var(--compute-light,#678086);stroke-width:3;stroke-linecap:round}
    .hex-atlas [data-compute-status=powered]{--compute-light:#c9ffe2}
    .hex-atlas [data-compute-status=powered] .compute-building{filter:drop-shadow(0 0 3px #80e8c7)}
    .hex-atlas [data-compute-status=idle] .compute-building{opacity:.6}
    .hex-atlas .district-status{font-size:10px;font-weight:750;letter-spacing:.5px;paint-order:stroke;stroke:#18393d;stroke-width:3px}
    .hex-atlas .blueprint{fill:#203f4d;fill-opacity:.8;stroke:#9ac8c6;stroke-dasharray:3 2;stroke-width:1}
    .hex-atlas .queue-caption{font-size:10px;fill:#ffdfa0;font-weight:650;paint-order:stroke;stroke:#18393d;stroke-width:3px}
    .hex-atlas .event-footprint{pointer-events:none}.hex-atlas .event-footprint text{font-size:10px;font-weight:700}
  </style>`;
}

// Scale bins are encoded by tone AND an explicit numeric label; icons never encode counts.
function reading(region, mode, initial) {
  if (mode === 'adequacy') return {
    value: initial ? null : nonnegative(region.sH) ? region.sH : null,
    label: initial ? 'unmeasured' : pct(region.sH), detail: `${number(region.H)} million people`,
  };
  if (mode === 'power') return {
    value: nonnegative(region.deliveredPower) ? region.deliveredPower : null,
    label: nonnegative(region.deliveredPower) ? `${number(region.deliveredPower)} TWh/year` : 'unavailable',
    detail: `Local ${number(region.rawPower)} TWh/year`,
  };
  return { value: nonnegative(region.active) ? region.active : null,
    label: nonnegative(region.active) ? `${number(region.active)} blocks` : 'unavailable',
    detail: `Q ${number(region.Q)} · ${number(region.B)} installed`,
  };
}

function terrainKind(terrain) {
  if (typeof terrain !== 'string') return 'plains';
  const kind = terrain.toLowerCase();
  if (/coast|water|island/.test(kind)) return 'coast';
  if (/mountain|highland|rock/.test(kind)) return 'highlands';
  if (/plateau|mesa/.test(kind)) return 'plateau';
  if (/wetland|marsh|delta/.test(kind)) return 'wetland';
  if (/forest|wood/.test(kind)) return 'forest';
  if (/arid|desert/.test(kind)) return 'arid';
  return 'plains';
}

function landscape(id, kind, seed, decorative = false) {
  if (kind === 'water') return `<path d="M-60-14q30-14 60 0t60 0M-80 12q35-14 70 0t70 0M-40 39q25-10 50 0" stroke="#91b7ad" stroke-opacity=".24" fill="none"/>`;
  const ground = `<path d="M-99 12Q-35-20 32 3T100 1M-80 34Q-10 5 62 25" fill="none" stroke="#68846a" stroke-opacity=".32" stroke-width="2"/>`;
  if (kind === 'coast') return `${ground}<path d="M-116-48Q-62-28-83 8T-45 69L0 96-117 47z" fill="#558d89"/><path d="M-110-49Q-56-29-77 9T-41 69" fill="none" stroke="#dfd5a8" stroke-width="3"/>${use(id, 'tree', 53, -9, .8)}`;
  if (kind === 'highlands') return `${ground}${use(id, 'hill', -32, -23, .95)}${use(id, 'hill', 43, 9, .7)}`;
  if (kind === 'plateau') return `${ground}${use(id, 'mesa', 0, -18, 1.15)}`;
  if (kind === 'wetland') return `<path d="M-108-24Q-30-55 3-22T106-5L105 27Q20 4-13 29T-108 35z" fill="#6f9d91"/><path d="M-108-24Q-30-55 3-22T106-5M-99 30Q-23 7 19 24" fill="none" stroke="#cbdbb1" stroke-width="2"/>${use(id, 'tree', -77, -3, .6)}`;
  if (kind === 'forest') return `${ground}${[-64, -28, 12, 49, 76].map((x, i) => use(id, 'tree', x, -19 + (i % 2) * 21, .7 + (i % 2) * .2)).join('')}`;
  if (kind === 'arid') return `<path d="M-95-5Q-50-45-5-5M-25 20Q25-25 78 15M-68 40Q-8 5 40 38" fill="none" stroke="#bda36f" stroke-width="3"/>`;
  return `${ground}${use(id, 'tree', -79, -15, .7)}${use(id, 'tree', 74, 4, .6)}${decorative && seed % 3 === 0 ? use(id, 'hill', 4, -5, .65) : ''}`;
}

function decoration(id, occupied, scale) {
  const cells = [];
  for (let r = -3; r <= 3; r++) for (let q = -3; q <= 3; q++) {
    const radius = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
    if (radius > 3 || occupied.has(`${q},${r}`)) continue;
    const seed = Math.abs(q * 31 + r * 17), { x, y } = xy(q, r, scale);
    const kind = radius === 3 && (q < -1 || r > 1) ? 'water'
      : ['forest', 'plains', 'highlands', 'coast', 'arid'][seed % 5];
    const fill = { water: '#28515c', coast: '#789b86', forest: '#799377', plains: '#9fa77e', highlands: '#85988a', arid: '#b8ac80' }[kind];
    cells.push({ y, svg: `<g transform="translate(${x} ${y}) scale(${scale})" opacity="${radius === 3 ? '.55' : '.78'}"><polygon points="${points(R - 3, 12)}" fill="#23473e"/><polygon points="${points(R - 3)}" fill="${fill}" stroke="#b5b79a" stroke-opacity=".25"/>${landscape(id, kind, seed, true)}<polygon points="${points(R - 3)}" fill="url(#${id}-grain)"/></g>` });
  }
  return `<g data-layer="decoration" aria-hidden="true">${cells.sort((a, b) => a.y - b.y).map(cell => cell.svg).join('')}</g>`;
}

function facilities(id, region, initial) {
  const kind = terrainKind(region.terrain), B = region.B;
  const status = !nonnegative(B) ? 'unavailable' : B === 0 ? 'absent' : initial ? 'unmeasured'
    : !nonnegative(region.active) ? 'unavailable' : region.active > 0 ? 'powered' : 'idle';
  const tier = B >= 200 ? 'complex' : B >= 100 ? 'campus' : 'hall';
  const homes = { plains: [-51, -5, 'city'], highlands: [-51, 4, 'city'], arid: [-50, -4, 'shore-house'], wetland: [-58, 0, 'shore-house'], plateau: [-27, -27, 'city'], coast: [-53, 0, 'shore-house'], forest: [-54, 6, 'shore-house'] }[kind];
  const [hx, hy, home] = homes;
  const settlement = region.H > 0 ? use(id, home, hx, hy, .8)
    + (['plains', 'wetland'].includes(kind) ? use(id, 'farm', -75, 17, .58) : '') : '';
  const fraction = B > 0 && nonnegative(region.active) ? Math.min(1, region.active / B) : 0;
  const label = status === 'absent' ? 'NO HARDWARE' : status === 'unmeasured' ? 'UNMEASURED' : status === 'unavailable' ? 'UNAVAILABLE' : status.toUpperCase();
  const detail = initial ? 'Powered compute: unmeasured at contact.' : `${number(region.active)} of ${number(B)} installed blocks powered in the last interval. Visual tiers: hall below 100, campus 100–199, complex 200+ installed blocks; symbols are not asset counts.`;
  return `<g data-key="district" data-district="${kind}">${settlement}
    ${region.F > 0 ? use(id, 'factory', kind === 'plateau' ? -66 : -5, kind === 'highlands' ? 17 : -15, .65) : ''}
    ${region.G > 0 ? use(id, 'power', 82, 1, .65) : ''}
    <path d="M-72 20L-8-12 65 20" fill="none" stroke="#e1d1a2" stroke-width="3" stroke-opacity=".55"/>
    <g data-key="compute" data-compute-status="${status}" data-visual-tier="${tier}"><title>${esc(detail)}</title>
    ${B > 0 ? `<g class="compute-building">${use(id, tier, 34, 10, .8)}</g>` : ''}
    <rect x="-35" y="18" width="122" height="13" rx="5" fill="#1c3d42"/>
    <circle cx="-27" cy="24" r="2.5" fill="${status === 'powered' ? '#c9ffe2' : '#294a51'}" stroke="#b3c9b2"/>
    ${text(-19, 27, label, 'district-status', `fill="${status === 'powered' ? '#c9ffe2' : '#d8d1b8'}"`)}
    <path d="M46 25h33" stroke="#627c77" stroke-width="3"/><path d="M46 25h${p(33 * fraction)}" stroke="#c9ffe2" stroke-width="3"/>
    </g></g>`;
}

function construction(id, region, t) {
  const queue = (Array.isArray(region.queue) ? region.queue : []).filter(p => p && p.amount > 0 && finite(p.due));
  const groups = PROJECTS.map(([kind, name, unit]) => ({ kind, name, unit, items: queue.filter(p => p.kind === kind) })).filter(g => g.items.length);
  if (!groups.length) return '';
  const next = Math.min(...queue.map(p => p.due));
  return `<g data-key="construction" pointer-events="none">${use(id, 'crane', -76, -51, .8)}
    ${text(-49, -65, `${queue.length} orders · yr ${number(next)}`, 'queue-caption')}
    ${groups.map(({ kind, name, unit, items }, i) => {
      const first = [...items].sort((a, b) => a.due - b.due || a.id - b.id)[0], delay = region.projectLeadTimes?.[kind];
      const start = finite(first.requestedDue) && nonnegative(delay) ? first.requestedDue - delay : null;
      const elapsed = start !== null && first.due > start ? Math.max(0, Math.min(1, (t - start) / (first.due - start))) : null;
      const amount = items.reduce((sum, p) => sum + p.amount, 0);
      const description = `${name}: ${items.length} prepaid orders, ${number(amount)} ${unit}. Next service: year ${number(first.due)}. ${elapsed === null ? 'Lead time unavailable' : `${number(elapsed * 100)}% lead time elapsed; this is a service delay, not measured physical completion`}.`;
      return `<g data-key="queue-${kind}" data-queue-kind="${kind}" data-orders="${items.length}"${elapsed === null ? '' : ` data-lead-elapsed="${p(elapsed)}"`}><title>${esc(description)}</title>
        <path class="blueprint" d="M${-48 + i * 25}-53l11-6 11 6v13l-11 6-11-6z"/>
        <path d="M${-46 + i * 25}-39h18" stroke="#35565c" stroke-width="3"/>
        ${elapsed === null ? '' : `<path d="M${-46 + i * 25}-39h${p(18 * elapsed)}" stroke="#ffe0a0" stroke-width="3"/>`}</g>`;
    }).join('')}</g>`;
}

function locationEffects(region, t) {
  const events = region.scenarioEvents ?? {};
  const active = (Array.isArray(events.active) ? events.active : []).filter(e => e && finite(e.start) && finite(e.end) && e.start <= t && t < e.end && e.amplitude > 0);
  const history = (Array.isArray(events.history) ? events.history : []).filter(e => e && e.type === 'event-start' && e.kind === 'technology' && finite(e.t) && e.t <= t && e.amplitude > 0);
  const pandemic = active.filter(e => e.kind === 'pandemic'), disaster = active.filter(e => e.kind === 'disaster');
  const badge = (kind, y, glyph, color, title, body) => `<g data-key="effect-${kind}" data-location-effect="${kind}" class="event-footprint ${kind}"><title>${esc(title)}</title>${body}<g transform="translate(91 ${y})"><circle r="12" fill="#17373d" stroke="${color}" stroke-width="2"/>${text(0, 4, glyph, '', `text-anchor="middle" fill="${color}"`)}</g></g>`;
  return `<g data-key="effects" pointer-events="none">${pandemic.length ? badge('pandemic', -55, '+', '#f2b4a1', `${pct(pandemic.reduce((s, e) => s + e.amplitude, 0))}/year additional mortality; active pandemic only. No transmission geography is modeled.`, '<ellipse class="health-perimeter" cx="-50" cy="-12" rx="33" ry="19" fill="none" stroke="#f2b4a1" stroke-width="2" stroke-dasharray="3 4"/>') : ''}
    ${disaster.length ? badge('disaster', -28, 'ϟ', '#ffd28d', `${pct(1 - disaster.reduce((s, e) => s * (1 - e.amplitude), 1))} electricity availability loss; active disaster only.`, '<path class="outage-fissure" d="M-95 11l18-8-5 13 29-12-6 15 23-4" fill="none" stroke="#725f50" stroke-width="4"/><path d="M-95 11l18-8-5 13 29-12-6 15 23-4" fill="none" stroke="#f4c389" stroke-width="1.3"/>') : ''}
    ${history.length && events.efficiency > 0 ? badge('technology', -82, '✧', '#b5ebd2', `${pct(events.efficiency)} reduction in base electricity need from recorded technology events; persistent efficiency benefit, not an active hazard.`, '<path class="technology-trace" d="M-75 17l24-12 20 10 29-14" fill="none" stroke="#b5ebd2" stroke-width="2.5"/>') : ''}
    </g>`;
}

function regionTile(region, context) {
  const { id, scale, mode, initial, maximum, selectedId, t } = context;
  const { x, y } = xy(region.q, region.r, scale), info = reading(region, mode, initial);
  const ratio = info.value === null ? null : Math.min(1, info.value / Math.max(maximum ?? 1, 1e-12));
  const color = ratio === null ? '#9ba6a1' : PALETTE[Math.min(3, Math.floor(ratio * 4))];
  const selected = selectedId === region.id, name = region.name ?? 'Unnamed region';
  const description = `${name}. ${modeTitle(mode)}: ${info.label}. ${info.detail}. Select region for details.`;
  const fill = { plains: '#c9c69a', forest: '#a7b895', highlands: '#b4bda5', coast: '#b9c5a5', arid: '#dbcca1', wetland: '#afc3a1', plateau: '#bcbc96' }[terrainKind(region.terrain)];
  const marker = `<path d="M-6-84h12l-6 10z" fill="${color}" stroke="#1b454a"/>`;
  return `<g class="region${selected ? ' is-selected' : ''}" data-region="${esc(region.id)}" data-q="${region.q}" data-r="${region.r}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="${esc(description)}" transform="translate(${x} ${y}) scale(${scale})">
    <title>${esc(description)}</title>
    <polygon points="${points(R - 4, 17)}" fill="#5c6d58" stroke="#243f39" stroke-width="2"/>
    <polygon class="region-surface" points="${points(R - 4)}" fill="${fill}"/>
    <polygon points="${points(R - 6)}" fill="url(#${id}-grain)"/>
    <polygon data-layer="overlay" points="${points(R - 6)}" fill="${color}" fill-opacity=".14" aria-hidden="true"/>
    <g data-key="landscape">${landscape(id, terrainKind(region.terrain), 0)}</g>${facilities(id, region, initial)}${marker}
    ${construction(id, region, t)}${locationEffects(region, t)}
    <path d="M-99 32H99V59L0 97-99 59z" fill="#163d43" fill-opacity=".96"/>
    <path d="M-95 33H95" stroke="${color}" stroke-width="3"/>
    <text x="0" y="51" text-anchor="middle" class="region-name">${short(name)}</text>
    ${text(0, 68, info.label, 'metric', `text-anchor="middle"${info.label.length > 14 ? ' style="font-size:16px"' : ''}`)}
    ${text(0, 82, info.detail, 'detail', 'text-anchor="middle"')}
    <g data-key="selection">${selected ? `<polygon class="selection-ring" points="${points(R + 2)}"/><path d="M-10-111H10L0-101z" fill="#ffe0a0"/>` : ''}</g>
    <polygon class="focus-ring" points="${points(R + 8)}"/>
    <g data-key="motion" pointer-events="none" aria-hidden="true"/>
  </g>`;
}

function linkLayer(links, regions, context) {
  const lookup = new Map(regions.map(region => [region.id, region]));
  const valid = links.filter(link => link && lookup.has(link.from) && lookup.has(link.to) && link.from !== link.to && nonnegative(link.capacity) && finite(link.flow));
  const maxCapacity = Math.max(1, ...valid.map(link => link.capacity));
  const body = valid.map(link => {
    const a = lookup.get(link.from), b = lookup.get(link.to);
    const start = xy(a.q, a.r, context.scale), end = xy(b.q, b.r, context.scale);
    const vx = end.x - start.x, vy = end.y - start.y, length = Math.hypot(vx, vy);
    if (length < 1) return '';
    // Keep the transfer marks in the channel between tile centers, above card labels.
    const x1 = p(start.x + vx * .28), y1 = p(start.y + vy * .28 - 37 * context.scale);
    const x2 = p(end.x - vx * .28), y2 = p(end.y - vy * .28 - 37 * context.scale);
    const reverse = link.flow < 0, flow = Math.abs(link.flow), width = (link.capacity / maxCapacity) * 10;
    const description = `${(reverse ? b.name : a.name) ?? 'Unnamed region'} → ${(reverse ? a.name : b.name) ?? 'Unnamed region'}: ${number(flow)} TWh/year flow; capacity ${number(link.capacity)} TWh/year.`;
    const path = reverse ? `M${x2} ${y2}L${x1} ${y1}` : `M${x1} ${y1}L${x2} ${y2}`;
    return `<g data-link="${esc(link.id)}" data-capacity="${link.capacity}" data-flow="${link.flow}" aria-label="${esc(description)}"><title>${esc(description)}</title><path class="link-track" d="${path}" stroke-width="${p(width)}"/>${flow > 0 ? `<path class="link-flow" d="${path}" stroke-width="${p(1 + 3 * Math.min(1, flow / Math.max(link.capacity, 1e-12)))}" marker-end="url(#${context.id}-arrow)"/>` : ''}<g class="link-label-panel" transform="translate(${p((x1 + x2) / 2)} ${p((y1 + y2) / 2 - 42)})"><rect x="-39" y="-11" width="78" height="18" rx="9" fill="#17292d" stroke="#8c9f91" stroke-width=".6"/>${text(0, 1, `${number(flow)} / ${number(link.capacity)}`, 'link-label', 'text-anchor="middle"')}</g></g>`;
  }).join('');
  return { svg: `<g data-layer="links" pointer-events="none" mask="url(#${context.id}-card-clearance)">${body}</g>`, omitted: links.length - valid.length };
}

function modeTitle(mode) {
  return { adequacy: 'Human needs', power: 'Delivered power', compute: 'Powered compute' }[mode];
}

function legendContent(mode, maximum) {
  const subtitle = mode === 'adequacy' ? 'Essential-resource adequacy · fixed 0–100% scale'
    : mode === 'power' ? 'Delivered after transfers · TWh/year · scale follows current view'
      : 'Powered blocks, last interval · rated 1 MW each · scale follows current view';
  const endpoint = mode === 'adequacy' ? '100%' : maximum === null ? 'view max' : number(maximum);
  return `${text(0, 0, modeTitle(mode), 'region-name')}${text(0, 20, subtitle, 'small')}
    ${PALETTE.map((color, i) => `<rect x="${i * 48}" y="32" width="46" height="7" rx="1" fill="${color}"/>`).join('')}
    ${text(0, 54, mode === 'adequacy' ? '0%' : '0', 'small')}${text(192, 54, endpoint, 'small', 'text-anchor="end"')}
    ${text(216, 39, 'Direct values remain visible in every region', 'small')}`;
}

/** Compact inline HTML for the parent page. Optional maximum pins a quantitative legend. */
export function mapLegend(overlay = 'adequacy', { maximum = null } = {}) {
  const mode = modeOf(overlay), max = nonnegative(maximum) ? maximum : null;
  const labels = mode === 'adequacy' ? ['0–25%', '25–50%', '50–75%', '75–100%']
    : ['Lower', '', '', max === null ? 'view max' : number(max)];
  const units = mode === 'power' ? ' · TWh/year' : mode === 'compute' ? ' · powered blocks' : '';
  return `<span>${esc(modeTitle(mode) + units)}</span>` + PALETTE.map((color, i) =>
    `<span><i aria-hidden="true" style="background:${color}"></i>${esc(labels[i])}</span>`).join('')
    + '<span>Links: TWh/year · values in Power grid</span>';
}

/** Render supplied regions/links, frameless for embedding by default.
 * Use {frameless:false} for the independent atlas header, compass and SVG legend.
 * Decorative terrain has no scientific/geographic meaning.
 */
function atlasMarkup(view = {}, { selectedId, overlay = 'adequacy', frameless = true } = {}, id) {
  const source = view && typeof view === 'object' ? view : {};
  const supplied = Array.isArray(source.regions) ? source.regions : [];
  const seen = new Set();
  const regions = supplied.filter(region => {
    if (!region || typeof region.id !== 'string' || seen.has(region.id) || !Number.isInteger(region.q) || !Number.isInteger(region.r) || Math.abs(region.q) > 100 || Math.abs(region.r) > 100) return false;
    seen.add(region.id); return true;
  });
  const links = Array.isArray(source.links) ? source.links : [];
  const mode = modeOf(overlay), initial = !finite(source.t) || source.t <= 0;
  const radius = Math.max(1, ...regions.map(region => Math.max(Math.abs(region.q), Math.abs(region.r), Math.abs(region.q + region.r))));
  const scale = Math.min(1, 1.1 / radius);
  const values = regions.map(region => reading(region, mode, initial).value).filter(value => value !== null);
  const maximum = mode === 'adequacy' ? 1 : values.length ? Math.max(...values) : null;
  const context = { id, scale, mode, initial, maximum, selectedId, t: nonnegative(source.t) ? source.t : 0 };
  const link = linkLayer(links, regions, context), omitted = supplied.length - regions.length + link.omitted;
  const subtitle = `Synthetic regions · axial scenario layout · surrounding decorative terrain has no model meaning`;
  return `<svg xmlns="${NS}" class="hex-atlas" viewBox="${frameless ? '300 150 840 565' : '0 0 1440 900'}" width="${frameless ? 840 : 1440}" height="${frameless ? 565 : 900}" preserveAspectRatio="xMidYMid meet" role="group" aria-labelledby="${id}-title ${id}-desc" data-overlay="${mode}">
    <title id="${id}-title">Regional strategy atlas · ${esc(modeTitle(mode))}</title>
    <desc id="${id}-desc">${esc(subtitle)}. ${regions.length} selectable regions. Tab to a region; Enter or Space selects through the map controller. Lines show actual supplied power connections. Visual tiers are schematic, not asset counts. Compute lights show last-interval activity. Blueprints show prepaid queue lead time, not physical completion. ${omitted ? `${omitted} invalid or unresolved entries omitted.` : ''}</desc>
    ${definitions(id)}${styles()}
    <defs><mask id="${id}-card-clearance" maskUnits="userSpaceOnUse" x="0" y="0" width="1440" height="900"><rect width="1440" height="900" fill="white"/>${regions.map(region=>{
      const {x,y}=xy(region.q,region.r,scale);
      return `<path d="M-102 30H102V61L0 101-102 61z" fill="black" transform="translate(${x} ${y}) scale(${scale})"/>`;
    }).join('')}</mask></defs>
    <rect width="1440" height="900" rx="12" fill="#17292d"/>
    ${frameless ? '' : `<rect x="9" y="9" width="1422" height="882" rx="9" fill="none" stroke="#b8a677" stroke-opacity=".5"/>
    ${text(40, 37, 'REGIONAL COMMONS  /  SCENARIO ATLAS', 'eyebrow')}
    ${text(40, 77, 'Land, power & possibility', 'title serif')}
    ${text(1398, 38, `YEAR ${number(source.t)}${finite(source.horizon) ? ` / ${number(source.horizon)}` : ''}`, 'eyebrow', 'text-anchor="end"')}
    ${text(1398, 74, modeTitle(mode), 'region-name', 'text-anchor="end"')}`}
    <g clip-path="url(#${id}-map)"><rect x="20" y="100" width="1400" height="674" fill="url(#${id}-sea)"/><rect x="20" y="100" width="1400" height="674" fill="url(#${id}-waves)"/>
      ${decoration(id, new Set(regions.map(region => `${region.q},${region.r}`)), scale)}
      <g data-layer="regions">${[...regions].sort((a, b) => a.r - b.r || a.q - b.q).map(region => regionTile(region, context)).join('')}</g>
      ${link.svg}
      ${regions.length === 0 ? `<rect x="504" y="384" width="432" height="86" rx="8" fill="#17292d"/>${text(720, 435, 'No regional data', 'title serif', 'text-anchor="middle"')}` : ''}
      ${frameless ? '' : `<g aria-hidden="true" transform="translate(1342 178)"><path d="M0-37L9-9 0-14-9-9z" fill="#e6d3a3"/><path d="M0 19V-29M-13 0h26" stroke="#d7c598" stroke-width="1"/><circle r="26" fill="none" stroke="#d7c598" stroke-opacity=".4"/>${text(0, -46, 'AXIAL r−', 'small', 'text-anchor="middle"')}</g>`}
    </g>
    ${frameless ? '' : `<path d="M40 788H1400" stroke="#c1b383" stroke-opacity=".4"/>
    <g transform="translate(40 815)">${legendContent(mode, maximum)}</g>
    <g transform="translate(700 813)"><path d="M0 10H38" stroke="#9dafa3" stroke-width="9"/><path d="M0 10H36" stroke="#fff1c9" stroke-width="2" marker-end="url(#${id}-arrow)"/>${text(52, 14, 'Width: link capacity · arrow: actual flow', 'legend-label')}${text(0, 36, 'Labels: flow / capacity · TWh/year · no arrow = zero flow', 'small')}${text(0, 56, 'Synthetic regions · decorative terrain · icons show presence, not size', 'small')}</g>`}
    ${omitted ? text(1396, 769, `${omitted} invalid or unresolved entries omitted`, 'small', 'text-anchor="end"') : ''}
  </svg>`;
}

export function renderHexMap(view = {}, options = {}) {
  return atlasMarkup(view, options, `hex-atlas-${++instance}`);
}

// Reconcile SVG elements by semantic identity. Unchanged regions, symbols and paths
// keep their DOM identity, keyboard focus and running CSS animation timelines.
const identity = node => node.nodeType !== 1 ? null : ['data-region', 'data-link', 'data-key', 'data-layer', 'id']
  .map(key => node.hasAttribute(key) ? `${key}:${node.getAttribute(key)}` : null).find(Boolean);
function reconcile(target, source) {
  if (source.nodeType !== 1) {
    if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
    return;
  }
  for (const attr of [...target.attributes]) if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
  for (const attr of [...source.attributes]) if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
  if (source.getAttribute('data-key') === 'motion') return;
  const existing = [...target.childNodes], used = new Set();
  const keyed = new Map(existing.map(node => [identity(node), node]).filter(([key]) => key));
  for (const [index, fresh] of [...source.childNodes].entries()) {
    const key = identity(fresh);
    const compatible = node => node && !used.has(node) && node.nodeType === fresh.nodeType && node.nodeName === fresh.nodeName;
    let current = key ? keyed.get(key) : existing[index];
    if (!compatible(current) || (!key && identity(current))) current = key ? null : existing.find(node => compatible(node) && !identity(node));
    if (!current) current = target.ownerDocument.importNode(fresh, true);
    else reconcile(current, fresh);
    used.add(current);
    if (target.childNodes[index] !== current) target.insertBefore(current, target.childNodes[index] ?? null);
  }
  for (const old of existing) if (!used.has(old)) old.remove();
}

/** Browser mount: update in place; standalone renderHexMap remains a pure string API. */
export function updateHexMap(root, view = {}, options = {}) {
  let mount = mounts.get(root);
  if (!mount || mount.svg.parentNode !== root) mount = { id: `hex-atlas-${++instance}`, svg: null };
  const Parser = root.ownerDocument.defaultView.DOMParser;
  const fresh = new Parser().parseFromString(atlasMarkup(view, options, mount.id), 'image/svg+xml').documentElement;
  if(!fresh||fresh.nodeName!=='svg'||fresh.getAttribute('xmlns')!==NS)throw new Error('Atlas could not be parsed as valid SVG');
  if (!mount.svg) {
    mount.svg = root.ownerDocument.importNode(fresh, true);
    root.replaceChildren(mount.svg);
  } else reconcile(mount.svg, fresh);
  mounts.set(root, mount);
  return mount.svg;
}
