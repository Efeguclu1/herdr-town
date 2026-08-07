'use strict';

const { P, mix } = require('./palette');

// The town runs on the real clock. Rather than a handful of hard-switched
// modes, the sky is a set of keyframes interpolated by hour, so dawn actually
// creeps in and sunset actually deepens. Colours stay near the Sweetie-16
// palette so it still reads as 8-bit rather than a photograph.
//
// darkness (0 = bright noon, 1 = deep night) drives everything that should
// respond to the light: star visibility, how much a lit window glows, how
// dark the ground reads.

const KEYS = [
  {
    h: 0, // deep night
    top: 0x141428, mid: 0x1a1c2c, bottom: 0x2a2340,
    ground: 0x1d5c3a, hill: 0x232a4d, darkness: 1,
  },
  {
    h: 4.5, // last of the night
    top: 0x161a30, mid: 0x24243f, bottom: 0x3b2f4a,
    ground: 0x1f6040, hill: 0x27305a, darkness: 0.95,
  },
  {
    h: 6, // first light
    top: 0x29366f, mid: 0x5d275d, bottom: 0xb13e53,
    ground: 0x256b45, hill: 0x35406e, darkness: 0.72,
  },
  {
    h: 7, // sunrise
    top: 0x3b5dc9, mid: 0xb13e53, bottom: 0xef7d57,
    ground: 0x2d7d4d, hill: 0x4a5a8c, darkness: 0.45,
  },
  {
    h: 8.5, // early morning
    top: 0x3b5dc9, mid: 0x41a6f6, bottom: 0xffcd75,
    ground: 0x34925a, hill: 0x5878a8, darkness: 0.2,
  },
  {
    h: 12, // midday
    top: 0x2f7fe0, mid: 0x41a6f6, bottom: 0x9fe4fb,
    ground: 0x38b764, hill: 0x6f95bd, darkness: 0,
  },
  {
    h: 16, // afternoon
    top: 0x357fd4, mid: 0x51a8ee, bottom: 0xbfe6f5,
    ground: 0x38b764, hill: 0x6f8fb5, darkness: 0.05,
  },
  {
    h: 18.5, // golden hour
    top: 0x4a5a9e, mid: 0xef7d57, bottom: 0xffcd75,
    ground: 0x2f8a55, hill: 0x5b5f8e, darkness: 0.3,
  },
  {
    h: 19.75, // sunset
    top: 0x3a3a72, mid: 0xb13e53, bottom: 0xef7d57,
    ground: 0x256b45, hill: 0x3e4172, darkness: 0.55,
  },
  {
    h: 21, // dusk
    top: 0x1e2350, mid: 0x5d275d, bottom: 0x6a3560,
    ground: 0x20603e, hill: 0x2b3159, darkness: 0.82,
  },
  {
    h: 22.5, // night falls
    top: 0x141428, mid: 0x1a1c2c, bottom: 0x2a2340,
    ground: 0x1d5c3a, hill: 0x232a4d, darkness: 1,
  },
];

const SUNRISE = 6.2;
const SUNSET = 19.6;

function lerpKey(a, b, t) {
  return {
    top: mix(a.top, b.top, t),
    mid: mix(a.mid, b.mid, t),
    bottom: mix(a.bottom, b.bottom, t),
    ground: mix(a.ground, b.ground, t),
    hill: mix(a.hill, b.hill, t),
    darkness: a.darkness + (b.darkness - a.darkness) * t,
  };
}

// Hour of day as a float. HERDR_TOWN_HOUR forces a time, which is the only
// practical way to look at dawn without waiting for dawn.
function currentHour(now = new Date()) {
  const forced = process.env.HERDR_TOWN_HOUR;
  if (forced !== undefined && forced !== '') {
    const v = Number(forced);
    if (Number.isFinite(v)) return ((v % 24) + 24) % 24;
  }
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}

function skyAt(hour) {
  let a = KEYS[KEYS.length - 1];
  let b = KEYS[0];
  let span = 24 - a.h + b.h;
  let t = span > 0 ? ((hour >= a.h ? hour - a.h : hour + 24 - a.h) / span) : 0;

  for (let i = 0; i < KEYS.length - 1; i++) {
    if (hour >= KEYS[i].h && hour < KEYS[i + 1].h) {
      a = KEYS[i];
      b = KEYS[i + 1];
      span = b.h - a.h;
      t = span > 0 ? (hour - a.h) / span : 0;
      break;
    }
  }

  const sky = lerpKey(a, b, Math.max(0, Math.min(1, t)));

  // Which body is up, and how far along its arc.
  const isDay = hour >= SUNRISE && hour < SUNSET;
  let bodyT;
  if (isDay) {
    bodyT = (hour - SUNRISE) / (SUNSET - SUNRISE);
  } else {
    const nightSpan = 24 - SUNSET + SUNRISE;
    bodyT = (hour >= SUNSET ? hour - SUNSET : hour + 24 - SUNSET) / nightSpan;
  }

  return {
    ...sky,
    hour,
    isDay,
    bodyT: Math.max(0, Math.min(1, bodyT)),
    // Sun sits low and red near the horizon, pale-gold overhead.
    sunColor: mix(P.red, P.yellow, Math.sin(Math.max(0, Math.min(1, bodyT)) * Math.PI)),
    starAlpha: Math.max(0, (sky.darkness - 0.45) / 0.55),
    label: describe(hour),
  };
}

function describe(hour) {
  if (hour < 4.5) return 'night';
  if (hour < 6.5) return 'dawn';
  if (hour < 8.5) return 'sunrise';
  if (hour < 11) return 'morning';
  if (hour < 15) return 'midday';
  if (hour < 18) return 'afternoon';
  if (hour < 19.5) return 'golden hour';
  if (hour < 20.75) return 'sunset';
  if (hour < 22.5) return 'dusk';
  return 'night';
}

function current(now) {
  return skyAt(currentHour(now));
}

module.exports = { current, skyAt, currentHour, describe, SUNRISE, SUNSET };
