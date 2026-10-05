/**
 * Circle packing for the wallet bubble map.
 *
 * Pure geometry: items in, positions out. No React, no data model, no fetch -
 * so the layout can be reasoned about and tested on its own.
 *
 * WHAT THE LAYOUT MEANS
 *
 * Position in most bubble charts is decoration. Here it carries one fact and
 * one only: wallets that belong to the same co-entry cluster are placed
 * TOGETHER, as a constellation, so a coordinated group reads as a group at a
 * glance instead of as rows 4, 9, 17 and 31 of a table. Everything else is
 * packed around them with no meaning attached to where it lands.
 *
 * Deliberately NOT a force simulation. A physics loop would re-run every
 * animation frame against a list that changes every five seconds, and the
 * bubbles would drift continuously while being read. This is a single
 * deterministic pass: the same input always produces the same picture, so a
 * poll that changes nothing moves nothing on screen.
 */

/** Ring radius that fits n circles around a centre without them touching. */
function ringRadius(radii) {
  if (radii.length < 2) return 0;
  const circumference = radii.reduce((sum, r) => sum + r * 2, 0) * 1.25;
  const fromCircumference = circumference / (2 * Math.PI);
  // Never smaller than the biggest member, or a large circle swallows the ring.
  return Math.max(fromCircumference, Math.max(...radii) * 1.15);
}

/** Lays members out around their group's local origin. */
function layoutGroup(members) {
  const radii = members.map((m) => m.r);
  const ring = ringRadius(radii);
  if (!ring) {
    return { placed: [{ ...members[0], dx: 0, dy: 0 }], radius: members[0].r };
  }
  // Largest first and evenly spaced: an ordered ring is far easier to read
  // than one where sizes alternate at random.
  const ordered = [...members].sort((a, b) => b.r - a.r);
  const placed = ordered.map((m, i) => {
    const angle = (i / ordered.length) * Math.PI * 2 - Math.PI / 2;
    return { ...m, dx: Math.cos(angle) * ring, dy: Math.sin(angle) * ring };
  });
  return { placed, radius: ring + Math.max(...radii) };
}

/**
 * Packs circles into a box, biggest first, each dropped at the first point on
 * an outward spiral where it touches nothing already placed.
 *
 * Greedy rather than optimal. For the sixty-odd bubbles this view shows, it
 * settles in well under a millisecond and leaves no visible gaps; an optimal
 * packing would cost a great deal more for a difference nobody could see.
 */
function packCircles(circles, width, height, padding, reserveCenter) {
  const cx = width / 2;
  const cy = height / 2;
  const placed = [];

  const fits = (x, y, r) => {
    if (x - r < padding || x + r > width - padding) return false;
    if (y - r < padding || y + r > height - padding) return false;
    // A hole kept clear in the middle, for a node that is not one of these
    // circles - the pool every one of these wallets traded against.
    if (reserveCenter > 0) {
      const dx = cx - x;
      const dy = cy - y;
      if (Math.sqrt(dx * dx + dy * dy) < reserveCenter + r + 4) return false;
    }
    return placed.every((p) => {
      const dx = p.x - x;
      const dy = p.y - y;
      // A small gap, so neighbouring bubbles read as separate shapes.
      return Math.sqrt(dx * dx + dy * dy) >= p.radius + r + 3;
    });
  };

  [...circles].sort((a, b) => b.radius - a.radius).forEach((c) => {
    if (!reserveCenter && fits(cx, cy, c.radius)) {
      placed.push({ ...c, x: cx, y: cy });
      return;
    }
    // Archimedean spiral: radius grows with angle, so the search sweeps
    // outward evenly instead of racing off in one direction.
    const step = Math.max(2, c.radius * 0.35);
    let angle = 0;
    let found = null;
    // Bounded so a box too small for the remaining circles cannot hang.
    for (let i = 0; i < 4000 && !found; i++) {
      angle += 0.35;
      const radius = step * angle * 0.25;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius * 0.72; // wider than tall
      if (radius > Math.max(width, height)) break;
      if (fits(x, y, c.radius)) found = { x, y };
    }
    if (found) placed.push({ ...c, x: found.x, y: found.y });
    else placed.push({ ...c, x: null, y: null, dropped: true });
  });

  return placed;
}

/**
 * @param items   [{ id, weight, groupId }] - weight drives area, groupId ties
 *                co-entry members together (null for independent wallets)
 * @param options { width, height, minRadius, maxRadius, padding }
 * @returns { bubbles, groups, dropped } - bubbles carry absolute x/y/r
 */
export function packBubbles(items, {
  width = 640, height = 360, minRadius = 5, maxRadius = 46, padding = 6,
  reserveCenter = 0,
} = {}) {
  const list = (items || []).filter((i) => i && i.id);
  if (!list.length) return { bubbles: [], groups: [], dropped: 0 };

  // Area, not radius, tracks the weight - a bubble twice the radius is four
  // times the ink, so scaling the radius linearly would exaggerate wildly.
  const peak = Math.max(...list.map((i) => Math.abs(i.weight) || 0), 1);
  const radiusFor = (weight) => {
    const share = Math.min(1, Math.abs(weight || 0) / peak);
    return minRadius + (maxRadius - minRadius) * Math.sqrt(share);
  };

  const byGroup = new Map();
  list.forEach((item) => {
    // Every ungrouped wallet is its own group, so one code path handles both.
    const key = item.groupId === null || item.groupId === undefined
      ? 'solo:' + item.id : 'group:' + item.groupId;
    const bucket = byGroup.get(key) || { key, groupId: item.groupId, members: [] };
    bucket.members.push({ ...item, r: radiusFor(item.weight) });
    byGroup.set(key, bucket);
  });

  const laid = [...byGroup.values()].map((bucket) => {
    const { placed, radius } = layoutGroup(bucket.members);
    return { ...bucket, placed, radius };
  });

  const packed = packCircles(laid, width, height, padding, reserveCenter);

  const bubbles = [];
  const groups = [];
  let dropped = 0;

  packed.forEach((group) => {
    if (group.dropped) { dropped += group.placed.length; return; }
    const members = group.placed.map((m) => ({
      id: m.id,
      data: m.data,
      r: m.r,
      x: group.x + m.dx,
      y: group.y + m.dy,
    }));
    bubbles.push(...members);
    if (group.groupId !== null && group.groupId !== undefined && members.length > 1) {
      groups.push({
        groupId: group.groupId,
        x: group.x,
        y: group.y,
        radius: group.radius,
        members: members.map((m) => ({ id: m.id, x: m.x, y: m.y })),
      });
    }
  });

  return { bubbles, groups, dropped };
}

export default packBubbles;
