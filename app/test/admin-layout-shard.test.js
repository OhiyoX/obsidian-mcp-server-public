// The Admin layout gate must be splittable (#378) without losing a check: a shard is a slice of the
// scene table, and the slices must tile it — every scene (and therefore every check it registers)
// exactly once, in table order, and `--shard=1/1` must be the unsharded run. A scene that reads rows
// another scene seeds (`group`) must travel with it in every shard count.
//
// No Chromium here: `selectScenes` is the whole partition, and fake scenes stand in for the real
// registrars so the check names can be counted without a browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShardArg, selectScenes, shardOwners } from '../scripts/web-regression/admin-layout-shard.mjs';

/** Fake scenes with the same shape as the real table; `alpha` seeds, `beta` reads those rows. */
function fakeScenes() {
  return [
    { id: 'alpha', group: 'seeded-pages', checks: ['alpha/one', 'alpha/two'] },
    { id: 'beta', group: 'seeded-pages', checks: ['beta/one'] },
    { id: 'gamma', checks: ['gamma/one', 'gamma/two'] },
    { id: 'delta', checks: ['delta/one'] },
    { id: 'epsilon', checks: ['epsilon/one', 'epsilon/two'] },
  ];
}

const sceneIds = (scenes) => scenes.map((scene) => scene.id);

function runShard(scenes, shard) {
  const ran = [];
  for (const scene of selectScenes(scenes, shard)) ran.push(...scene.checks);
  return ran;
}

test('no --shard flag means the whole scene, in table order', () => {
  assert.equal(parseShardArg([]), null);
  assert.equal(parseShardArg(['--verbose']), null);
  assert.deepEqual(selectScenes(fakeScenes(), null), fakeScenes());
});

test('--shard=<i>/<n> is parsed, and an out-of-range index is rejected', () => {
  assert.deepEqual(parseShardArg(['--shard=2/3']), { index: 2, count: 3 });
  for (const bad of ['--shard=0/3', '--shard=4/3', '--shard=1/0', '--shard=1', '--shard=a/b', '--shard=']) {
    assert.throws(() => parseShardArg([bad]), /--shard/, bad);
  }
  assert.throws(() => parseShardArg(['--shard=1/2', '--shard=2/2']), /given 2 times/);
});

test('every shard runs its own slice, and the union is the full list with no duplicate and no gap', () => {
  const scenes = fakeScenes();
  const all = runShard(scenes, null);
  // More shards than GROUPS cannot fill every shard: a group is never split.
  const groupCount = new Set(scenes.map((scene) => scene.group ?? scene.id)).size;
  for (let count = 1; count <= 6; count += 1) {
    const perShard = [];
    for (let index = 1; index <= count; index += 1) perShard.push(runShard(scenes, { index, count }));
    const union = perShard.flat();
    assert.equal(new Set(union).size, union.length, `${count} shards ran a check twice`);
    assert.deepEqual([...union].sort(), [...all].sort(), `${count} shards do not tile the full list`);
    for (let index = 0; index < count; index += 1) {
      for (let other = index + 1; other < count; other += 1) {
        const shared = perShard[index].filter((name) => perShard[other].includes(name));
        assert.equal(shared.length, 0, `${count} shards: ${index + 1} and ${other + 1} overlap`);
      }
      if (count <= groupCount) assert.ok(perShard[index].length > 0, `${count} shards left shard ${index + 1} empty`);
    }
  }
});

test('a scene that reads another scene\'s seeded rows is never in a different shard', () => {
  const scenes = fakeScenes();
  for (let count = 1; count <= 6; count += 1) {
    const owners = shardOwners(scenes, count);
    assert.equal(owners.get('beta'), owners.get('alpha'), `${count} shards split the seeded-pages group`);
    const seeded = selectScenes(scenes, { index: owners.get('alpha'), count });
    assert.deepEqual(sceneIds(seeded).filter((id) => id === 'alpha' || id === 'beta'), ['alpha', 'beta'], `${count} shards: the seed must run before its reader`);
  }
});

test('a single shard equals the unsharded run, same names and same order', () => {
  const scenes = fakeScenes();
  assert.deepEqual(runShard(scenes, { index: 1, count: 1 }), runShard(scenes, null));
  assert.deepEqual(sceneIds(selectScenes(scenes, { index: 1, count: 1 })), sceneIds(scenes));
});
