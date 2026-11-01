const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../assets/shared.js');

test('zones in spec order', () => {
  assert.deepEqual(S.ZONES.map(z => [z.id, z.label, z.color, z.icon]), [
    ['know', 'เข้าใจ', '#6366F1', 'book'], ['do', 'ลงมือ', '#10B981', 'tool'],
    ['see', 'ดูของจริง', '#F59E0B', 'eye'], ['warn', 'ระวัง', '#EF4444', 'alert'],
    ['next', 'ไปต่อ', '#0EA5E9', 'compass']]);
});
test('18 default groups', () => {
  assert.equal(Object.values(S.DEFAULT_GROUPS).flat().length, 18);
  assert.deepEqual(S.DEFAULT_GROUPS.do, ['ขั้นตอนการทำ', 'สิ่งที่ต้องมี', 'ทักษะและทีม', 'ทางเลือกและวิธีเลือก', 'เทคนิค']);
});
test('directions', () => assert.deepEqual(S.DIRECTIONS.map(d => d.id),
  ['detail', 'examples', 'compare', 'downsides', 'refresh', 'question']));
test('depth presets', () => assert.deepEqual(S.DEPTHS.standard,
  { label: 'มาตรฐาน', levels: 2, sources: 30, minutes: '15–20' }));
test('slug pattern', () => { assert.ok(S.SLUG_RE.test('awwwards-3d-web')); assert.ok(!S.SLUG_RE.test('Awwwards 3D')); });
