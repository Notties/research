(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.DRShared = f();
})(this, function () {
  const ZONES = [
    { id: 'know', label: 'เข้าใจ', color: '#6366F1', icon: 'book' },
    { id: 'do', label: 'ลงมือ', color: '#10B981', icon: 'tool' },
    { id: 'see', label: 'ดูของจริง', color: '#F59E0B', icon: 'eye' },
    { id: 'warn', label: 'ระวัง', color: '#EF4444', icon: 'alert' },
    { id: 'next', label: 'ไปต่อ', color: '#0EA5E9', icon: 'compass' },
  ];

  const DEFAULT_GROUPS = {
    know: ['ภาพรวม', 'ศัพท์ที่ต้องรู้', 'รากฐาน'],
    do: ['ขั้นตอนการทำ', 'สิ่งที่ต้องมี', 'ทักษะและทีม', 'ทางเลือกและวิธีเลือก', 'เทคนิค'],
    see: ['ตัวอย่างจริง', 'ผู้เล่นหลัก', 'เกณฑ์ว่าแบบไหนดี'],
    warn: ['ข้อควรระวัง', 'ความเข้าใจผิด', 'ต้นทุนและเวลา'],
    next: ['ต่อยอดต่อ', 'เทรนด์', 'แหล่งเรียนรู้และคอมมูนิตี้', 'คำถามที่ยังเปิดอยู่'],
  };

  const DIRECTIONS = [
    { id: 'detail', label: 'ลงรายละเอียด' },
    { id: 'examples', label: 'หาตัวอย่างจริง' },
    { id: 'compare', label: 'เทียบทางเลือก' },
    { id: 'downsides', label: 'หาข้อเสียและข้อโต้แย้ง' },
    { id: 'refresh', label: 'อัปเดตข้อมูลให้ใหม่' },
    { id: 'question', label: 'พิมพ์คำถามเอง' },
  ];

  const STATUSES = ['planned', 'researching', 'checking', 'done', 'frontier'];
  const QUEUE_STATUSES = ['pending', 'researching'];
  const SOURCE_TYPES = ['official', 'primary', 'secondary', 'community', 'video'];
  const POINT_TYPES = ['fact', 'opinion', 'estimate'];
  const CONFIDENCE = ['high', 'medium', 'low'];

  const DEPTHS = {
    quick: { label: 'เร็ว', levels: 1, sources: 15, minutes: '5–10' },
    standard: { label: 'มาตรฐาน', levels: 2, sources: 30, minutes: '15–20' },
    deep: { label: 'ลึก', levels: 3, sources: 50, minutes: '30–45' },
  };

  const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  return { ZONES, DEFAULT_GROUPS, DIRECTIONS, STATUSES, QUEUE_STATUSES, SOURCE_TYPES, POINT_TYPES, CONFIDENCE, DEPTHS, SLUG_RE };
});
