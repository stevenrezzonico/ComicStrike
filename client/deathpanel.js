// Our death as a comic panel (#deathpanel in index.html), for the moment before the camera
// goes to a teammate: the view tilts inside a heavy ink frame closing in from the edges,
// focus lines rush in, a big jagged word bursts in the middle (K.O.!, BONK! on a
// headshot, KA-BOOM! from the bomb) and a narration box names who did it. The print itself
// turns to a red-brown duotone (Renderer.style.dead, COMPOSITE_FS u_dead). DOM made once;
// show() runs every frame but touches the DOM only when the state changes.

const pick = (a) => a[(Math.random() * a.length) | 0];

// A jagged burst outline (percent polygon), made once.
const BURST = (() => {
  const n = 14, pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = i / (n * 2) * Math.PI * 2, r = i % 2 ? 31 + (i * 7 % 5) : 50;
    pts.push(`${(50 + Math.cos(a) * r).toFixed(1)}% ${(50 + Math.sin(a) * r).toFixed(1)}%`);
  }
  return `polygon(${pts.join(',')})`;
})();

// The word by what killed us (shared/weapons.js names).
function wordFor(weapon, headshot, self) {
  if (!weapon) return self ? pick(['OOPS!', 'WHUMP!']) : pick(['K.O.!', 'ARGH!']);
  if (weapon.c4) return 'KA-BOOM!';
  if (weapon.name === 'hegrenade') return 'BOOM!';
  if (weapon.name === 'molotov' || weapon.name === 'incgrenade') return 'FWOOSH!';
  if (weapon.name === 'knife') return 'SHNK!';
  if (headshot) return 'BONK!';
  return self ? 'OOPS!' : pick(['K.O.!', 'ARGH!', 'OOF!', 'UGH!']);
}

export class DeathPanel {
  constructor(root) {
    this.root = root;
    root.innerHTML = '<div class="dp-lines"></div><div class="dp-frame"></div>' +
      '<div class="dp-word"><i class="bk"></i><i class="fg"></i><b></b><small></small></div>' +
      '<div class="dp-caption"><span></span><em></em></div>';
    this.word = root.querySelector('.dp-word b');
    this.sub = root.querySelector('.dp-word small');
    this.caption = root.querySelector('.dp-caption span');
    this.how = root.querySelector('.dp-caption em');
    for (const i of root.querySelectorAll('.dp-word i')) i.style.clipPath = BURST;
    this.on = false;
  }

  // Who killed us: their name (null: the world or ourselves), the weapon (WEAPONS entry
  // or null), a headshot; self: our own doing.
  killed(name, weapon, headshot, self) {
    this.word.textContent = wordFor(weapon, headshot, self);
    this.sub.textContent = headshot && weapon && !weapon.c4 ? 'HEADSHOT' : '';
    this.caption.textContent = weapon?.c4 ? 'The bomb went off.' : self || !name ? 'You took yourself out.'
      : `Taken down by ${name}`;
    this.how.textContent = weapon && !weapon.c4 && !self ? `${weapon.label}${headshot ? ', one to the head' : ''}` : '';
  }

  // Every frame: the panel shows while `on` (dead, before spectating).
  show(on) {
    if (on === this.on) return;
    this.on = on;
    this.root.classList.toggle('on', on);
    document.body.classList.toggle('dying', on);
  }
}
