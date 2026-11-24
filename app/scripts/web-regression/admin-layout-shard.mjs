// Deterministic shard selection for the Admin layout gate (issue #378).
//
// The scene is ONE process with ONE fixture, so a shard is a slice of SCENES, not of checks: a check
// body cannot run without the setup its scene performs first (seeding, its own server, its own
// browser context). Every check a scene registers travels with that scene, so "each scene exactly
// once" means "each check exactly once".
//
// Assignment is the position of the scene's GROUP in the table, modulo the shard count: it depends on
// nothing but the table order, so it is stable across machines, load and file-system order. A scene
// that needs rows another scene seeds declares that scene's group (`group: 'seeded-pages'`), so the
// two can never land in different shards.
export function parseShardArg(argv) {
  const given = argv.filter((arg) => String(arg).startsWith('--shard='));
  if (given.length === 0) return null;
  if (given.length > 1) throw new Error(`--shard was given ${given.length} times, give it once`);
  const match = /^--shard=(\d{1,3})\/(\d{1,3})$/.exec(given[0]);
  if (!match) throw new Error(`--shard must be written --shard=<i>/<n>, got ${given[0]}`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1) throw new Error(`--shard needs <n> >= 1, got ${count}`);
  if (index < 1 || index > count) throw new Error(`--shard=${index}/${count} is out of range: 1 <= <i> <= <n>`);
  return { index, count };
}

/** Scene id -> owning shard (1-based), from the first appearance of each group in the table. */
export function shardOwners(scenes, count) {
  const groups = [];
  const owners = new Map();
  for (const scene of scenes) {
    const group = scene.group ?? scene.id;
    if (!groups.includes(group)) groups.push(group);
    owners.set(scene.id, (groups.indexOf(group) % count) + 1);
  }
  return owners;
}

/** The scenes of one shard, in table order. No shard means the whole table (today's behaviour). */
export function selectScenes(scenes, shard) {
  if (!shard) return scenes.slice();
  const owners = shardOwners(scenes, shard.count);
  return scenes.filter((scene) => owners.get(scene.id) === shard.index);
}
