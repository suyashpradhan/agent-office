// Pixel-art characters, drawn from rectangles (no image assets).
// A character is ~14x24 logical pixels, anchored at the middle of its feet.

export function shade(hex, amount) {
  const n = parseInt(hex.replace('#', ''), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + (amount < 0 ? c * amount : (255 - c) * amount))));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

const HAIR_STYLES = ['short', 'bob', 'spiky'];
const DARK = '#2a1e1a';
const PANTS = '#3a3f58';
const SHOES = '#23232d';

// look: { color, hair, skin, accessory, index }
// state: { x, y, dir: 'down'|'up'|'left'|'right', pose: 'stand'|'desk'|'couch', moving, frame, blink, t }
export function drawCharacter(ctx, look, state) {
  const style = look.hairStyle || HAIR_STYLES[(look.index ?? 0) % HAIR_STYLES.length];
  const x = Math.round(state.x);
  const y = Math.round(state.y);
  const frame = state.frame % 4;
  const bob = state.moving && (frame === 1 || frame === 3) ? -1 : 0;
  const shirt = look.color;
  const shirtDark = shade(shirt, -0.22);
  const skin = look.skin;
  const hair = look.hair;

  ctx.save();
  if (state.dir === 'right') {
    ctx.translate(x * 2, 0);
    ctx.scale(-1, 1);
  }
  const ox = x - 7;
  let oy = y - 24 + bob;
  const r = (dx, dy, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(ox + dx, oy + dy, w, h);
  };

  // shadow
  if (state.pose !== 'desk') {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(x - 6, y - 1 - bob * 0, 12, 2);
    ctx.fillRect(x - 5, y - 2, 10, 1);
  }

  if (state.pose === 'desk') {
    // seated at a desk, seen from behind, typing
    oy += 4;
    const tap = Math.floor(state.t / 180) % 2;
    r(1, 11, 12, 6, shirt);
    r(-1, 12 + tap, 2, 3, shirtDark);
    r(13, 13 - tap, 2, 3, shirtDark);
    r(6, 10, 2, 1, shade(skin, -0.1));
    drawHeadBack(r, style, hair, look);
    ctx.restore();
    return;
  }

  if (state.pose === 'couch') {
    oy += 3;
    r(3, 18, 8, 2, PANTS);
    r(3, 20, 3, 2, SHOES);
    r(8, 20, 3, 2, SHOES);
    drawTorsoFront(r, shirt, shirtDark, skin, 0);
    drawHeadFront(r, style, hair, skin, look, state.blink);
    ctx.restore();
    return;
  }

  if (state.dir === 'down' || state.dir === 'up') {
    // legs (one lifts on walk frames 1 and 3)
    const liftL = state.moving && frame === 1 ? 1 : 0;
    const liftR = state.moving && frame === 3 ? 1 : 0;
    r(3, 18, 3, 4 - liftL, PANTS);
    r(8, 18, 3, 4 - liftR, PANTS);
    r(3, 22 - liftL, 3, 2, SHOES);
    r(8, 22 - liftR, 3, 2, SHOES);
    const swing = state.moving ? (frame === 1 ? 1 : frame === 3 ? -1 : 0) : 0;
    drawTorsoFront(r, shirt, shirtDark, skin, swing);
    if (state.dir === 'down') drawHeadFront(r, style, hair, skin, look, state.blink);
    else drawHeadBack(r, style, hair, look);
  } else {
    // side view, facing left (mirrored above for right)
    const spread = state.moving && (frame === 1 || frame === 3);
    if (spread) {
      r(3, 18, 3, 4, PANTS);
      r(8, 18, 3, 4, PANTS);
      r(2, 22, 3, 2, SHOES);
      r(8, 22, 3, 2, SHOES);
    } else {
      r(5, 18, 4, 4, PANTS);
      r(4, 22, 4, 2, SHOES);
    }
    r(4, 11, 6, 7, shirt);
    r(4, 17, 6, 1, shirtDark);
    const armX = state.moving ? (frame === 1 ? 5 : frame === 3 ? 7 : 6) : 6;
    r(armX, 12, 2, 5, shirtDark);
    r(armX, 17, 2, 1, skin);
    r(6, 10, 2, 1, shade(skin, -0.1));
    // head
    r(3, 2, 8, 8, skin);
    r(2, 6, 1, 1, skin); // nose
    r(4, 5, 1, 2, state.blink ? skin : DARK);
    if (state.blink) r(4, 6, 1, 1, DARK);
    r(4, 8, 2, 1, shade(skin, -0.3));
    r(3, 0, 8, 3, hair);
    r(7, 2, 4, style === 'bob' ? 8 : 6, hair);
    if (style === 'spiky') {
      r(4, -1, 2, 1, hair);
      r(7, -2, 2, 2, hair);
    }
    if (look.accessory === 'glasses') {
      r(3, 4, 3, 1, '#2b2b2b');
      r(3, 7, 3, 1, '#2b2b2b');
      r(3, 4, 1, 4, '#2b2b2b');
      r(6, 5, 2, 1, '#2b2b2b');
    }
    if (look.accessory === 'beret') {
      r(2, -1, 10, 2, '#c0392b');
      r(6, -2, 2, 1, '#c0392b');
    }
    if (look.accessory === 'headphones') {
      r(4, -1, 6, 1, '#333');
      r(7, 4, 3, 4, look.color);
      r(7, 4, 3, 1, '#333');
    }
  }
  ctx.restore();
}

function drawTorsoFront(r, shirt, shirtDark, skin, swing) {
  r(2, 11, 10, 7, shirt);
  r(2, 17, 10, 1, shirtDark);
  r(1, 11 + swing, 1, 6, shirtDark);
  r(12, 11 - swing, 1, 6, shirtDark);
  r(1, 17 + swing, 1, 1, skin);
  r(12, 17 - swing, 1, 1, skin);
  r(6, 10, 2, 1, shade(skin, -0.1));
  r(5, 11, 4, 1, shade(shirt, 0.25)); // collar
}

function drawHeadFront(r, style, hair, skin, look, blink) {
  r(3, 2, 8, 8, skin);
  // eyes
  if (blink) {
    r(4, 6, 2, 1, DARK);
    r(8, 6, 2, 1, DARK);
  } else {
    r(4, 5, 2, 2, DARK);
    r(8, 5, 2, 2, DARK);
    r(4, 5, 1, 1, '#ffffff');
    r(8, 5, 1, 1, '#ffffff');
  }
  r(3, 8, 1, 1, shade(skin, -0.12)); // cheeks
  r(10, 8, 1, 1, shade(skin, -0.12));
  r(6, 8, 2, 1, shade(skin, -0.3)); // mouth
  // hair
  if (style === 'bob') {
    r(2, 0, 10, 3, hair);
    r(1, 2, 2, 7, hair);
    r(11, 2, 2, 7, hair);
    r(3, 3, 8, 1, hair);
  } else if (style === 'spiky') {
    r(2, 0, 10, 3, hair);
    r(3, -1, 2, 1, hair);
    r(6, -2, 2, 2, hair);
    r(9, -1, 2, 1, hair);
    r(2, 3, 1, 2, hair);
    r(11, 3, 1, 2, hair);
  } else {
    r(2, 0, 10, 3, hair);
    r(2, 3, 1, 3, hair);
    r(11, 3, 1, 3, hair);
    r(3, 3, 3, 1, hair);
  }
  if (look.accessory === 'glasses') {
    const g = '#2b2b2b';
    r(3, 4, 4, 1, g);
    r(3, 7, 4, 1, g);
    r(3, 4, 1, 4, g);
    r(6, 4, 1, 4, g);
    r(7, 4, 4, 1, g);
    r(7, 7, 4, 1, g);
    r(7, 4, 1, 4, g);
    r(10, 4, 1, 4, g);
  }
  if (look.accessory === 'beret') {
    r(2, -1, 10, 2, '#c0392b');
    r(1, 0, 3, 1, '#c0392b');
    r(6, -2, 2, 1, '#c0392b');
  }
  if (look.accessory === 'headphones') {
    r(2, -1, 10, 1, '#333');
    r(1, 0, 1, 4, '#333');
    r(12, 0, 1, 4, '#333');
    r(0, 4, 2, 4, look.color);
    r(12, 4, 2, 4, look.color);
  }
}

function drawHeadBack(r, style, hair, look) {
  r(3, 2, 8, 8, hair);
  r(2, 0, 10, 3, hair);
  if (style === 'bob') r(1, 2, 12, 8, hair);
  if (style === 'spiky') {
    r(3, -1, 2, 1, hair);
    r(6, -2, 2, 2, hair);
    r(9, -1, 2, 1, hair);
  }
  if (look.accessory === 'beret') {
    r(2, -1, 10, 2, '#c0392b');
    r(6, -2, 2, 1, '#c0392b');
  }
  if (look.accessory === 'headphones') {
    r(2, -1, 10, 1, '#333');
    r(0, 4, 2, 4, look.color);
    r(12, 4, 2, 4, look.color);
  }
  if (look.accessory === 'glasses') {
    r(2, 5, 1, 1, '#2b2b2b');
    r(11, 5, 1, 1, '#2b2b2b');
  }
}
