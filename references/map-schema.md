# รูปแบบข้อมูลของแผนที่ (map-schema)

`map.json` เป็นข้อมูลหลักเพียงที่เดียวของหัวข้อหนึ่ง (`C:\_research\<slug>\map.json`) หน้าแผนที่ `index.html` และ `report.md` สร้างจากไฟล์นี้ทั้งหมด เอกสารนี้บอกว่าในไฟล์มีอะไร และ fragment ที่ผู้ช่วยรีเสิร์ชส่งกลับต้องหน้าตาแบบไหน เพื่อให้ `merge` รับได้ในครั้งเดียว

ข้อความทุกช่องเป็นข้อความธรรมดา ไม่ใช้ Markdown หรือ HTML เพราะหน้าแผนที่แสดงตามที่เขียน เขียนเป็นภาษาไทยและคงศัพท์เทคนิคภาษาอังกฤษ

| ผู้เขียน | เขียนอะไร | ด้วยอะไร |
|---|---|---|
| ผู้ช่วยรีเสิร์ช | ไฟล์ fragment ใน `fragments/` เท่านั้น | Write tool |
| Claude หลัก | ตัวแผนที่ | คำสั่ง `dr.cjs` (`merge`, `synthesize`, `mark-checked`, `accept`, `start`, `finish`) ไม่แก้ `map.json` ด้วยมือ ยกเว้นตอนปรับแผนผังก่อนเริ่มขุด (structure.md) |

## 1. ระดับไฟล์

| ช่อง | ชนิด | ความหมายและข้อกำหนด |
|---|---|---|
| `schemaVersion` | ตัวเลข | เป็น 1 เสมอ |
| `topic` | ข้อความ | ชื่อหัวข้อ ห้ามว่าง |
| `slug` | ข้อความ | ภาษาอังกฤษตัวเล็ก ตัวเลข และขีดคั่น เช่น `awwwards-3d-web` (ตรงกับ `^[a-z0-9]+(?:-[a-z0-9]+)*$` ยาวไม่เกิน 64 ตัวอักษร) ใช้เป็นชื่อโฟลเดอร์ |
| `createdAt`, `updatedAt` | วันเวลา ISO | `updatedAt` ถูกตั้งใหม่ทุกครั้งที่บันทึก |
| `brief` | object | สิ่งที่ผู้ใช้ตอบตอนเริ่ม (หัวข้อ 6) |
| `summary` | object | `findings` ไม่เกิน 5 ข้อ ข้อละ `{ text, cites }` ที่ต้องมี 2 แหล่งหรือ `singleSource: true` และ `startTomorrow` ไม่เกิน 3 ข้อ เป็นข้อความ เขียนด้วย `synthesize` (หัวข้อ 5) |
| `readingPath` | รายการ id โหนด | ลำดับการอ่าน 8–12 โหนด เขียนด้วย `synthesize` |
| `sources` | object | id → แหล่ง (หัวข้อ 3) |
| `queue` | รายการ | คำขอขุดต่อที่ค้างอยู่ ข้อละ `{ id, nodeId, direction, question?, at, status }` โดย `status` เป็น `pending` หรือ `researching` ไม่เขียนเอง ใช้ `accept`, `start`, `finish` (expansion.md) |
| `root` | โหนด | โหนดราก (หัวข้อ 2) |
| `inboxOffset` | ตัวเลข | ตำแหน่งที่อ่าน `inbox.jsonl` ถึงแล้ว เป็นของระบบ ห้ามแก้ |

ระวังชื่อซ้ำ `summary` ระดับไฟล์เป็น object แต่ `summary` ของโหนดเป็นข้อความ

## 2. โหนด

ต้นไม้มี 4 ระดับ ค่าของ `level` คือ `root` (หัวข้อ) → `zone` (5 โซนคงที่ id `z-know`, `z-do`, `z-see`, `z-warn`, `z-next`) → `group` → `item` โดย `item` ซ้อนใต้ `item` ได้ไม่จำกัดชั้น

| ช่อง | ความหมาย |
|---|---|
| `id` | ไม่ซ้ำกันทั้งแผนที่ ใช้ตัวอักษรอังกฤษพิมพ์เล็ก ตัวเลข และขีดกลางเท่านั้น (`a-z0-9-`) ห้ามมี `:` หรือ `;` เพราะคิวขุดต่อเข้ารหัสเป็น `nodeId:direction[:question]; ...` validator ไม่ตรวจข้อนี้ แต่คิวจะพังถ้าฝ่าฝืน ถ้าเพิ่มโหนดด้วยมือ (กลุ่มใหม่ตอนปรับแผนผัง) ต้องตามกฎนี้ ส่วน `merge` ตั้ง id ของโหนดใหม่เองเป็น `<id พ่อแม่>-<ลำดับ>` จึงถูกต้องเสมอ |
| `title` | ชื่อโหนด สั้นและอ่านรู้เรื่อง (ไม่เกินราว 28 ตัวอักษร ชื่อบนแผนที่ถูกตัดที่ 28 ตัวอักษร) |
| `level` | `root`, `zone`, `group` หรือ `item` |
| `zone` | สเปกระบุไว้ แต่ข้อมูลจริงไม่เก็บ หน้าแผนที่หาโซนจากตำแหน่งของโหนดในต้นไม้ ไม่ต้องใส่ |
| `status` | `planned`, `researching`, `checking`, `done`, `frontier` ตารางด้านล่าง ไม่มีใครตั้งเอง ใช้คำสั่ง |
| `summary` | สรุปของโหนด 1–2 ประโยค เขียนให้คนเริ่มจากศูนย์อ่านรู้เรื่อง สรุปเฉพาะสิ่งที่อยู่ใน `points` (ของโหนดเองหรือของลูก) ห้ามเพิ่มข้อเท็จจริงใหม่ที่ไม่มีอ้างอิง |
| `why` | หนึ่งประโยคว่าทำไมโหนดนี้สำคัญกับเป้าหมายของผู้ใช้ (ไม่บังคับ) |
| `points` | รายการ claim ชนิดข้อเท็จจริง ความเห็น หรือค่าประมาณ (ตารางด้านล่าง) |
| `conflicts` | รายการ `{ text, cites }` เมื่อแหล่งขัดกัน ต้องแสดงทั้งสองฝั่งและอ้างทั้งสองฝั่ง |
| `counterpoints` | รายการ `{ text, cites }` ข้อโต้แย้งและข้อจำกัดต่อสิ่งที่โหนดพูด |
| `forYou` | คำแนะนำตามเป้าหมายของผู้ใช้ ผู้ช่วยรีเสิร์ชไม่เขียน Claude หลักเขียนตอนสังเคราะห์ด้วย `synthesize` ซึ่งไม่แตะ `status` และ `researchedAt` (`merge` ตั้งโหนดพ่อแม่เป็น `checking` ทุกครั้ง) ยกเว้นลูกใหม่ที่ `examples`, `compare` และ `question` สร้าง ซึ่งใส่ `forYou` ใน fragment ได้เลย (expansion.md) |
| `confidence` | `high`, `medium` หรือ `low` |
| `confidenceReason` | เหตุผลของระดับความมั่นใจ ห้ามว่างเมื่อโหนดมี `points` |
| `related` | รายการ id โหนดอื่นที่เกี่ยวข้อง ต้องมีอยู่ในแผนที่แล้ว |
| `logo` | ชื่อใน Simple Icons ของเครื่องมือหรือผลิตภัณฑ์ที่โหนดพูดถึง เช่น `threedotjs` เป็นตัวอักษรพิมพ์เล็กกับตัวเลขเท่านั้น ใส่เฉพาะที่มั่นใจว่ามีจริง ไม่แน่ใจไม่ต้องใส่ (หน้าแผนที่ใช้ไอคอนกลางแทน) |
| `researchedAt` | เวลาที่รีเสิร์ชล่าสุด `merge` ตั้งให้ |
| `expansions` | ประวัติการขุดต่อ `{ direction, question?, at }` `finish` เขียนให้ |
| `children` | โหนดลูก |

สถานะของโหนด:

| `status` | ความหมาย | ใครตั้ง |
|---|---|---|
| `planned` | วางแผนไว้ ยังไม่ได้ขุด (เส้นประ) | `init` และตอนปรับแผนผัง |
| `researching` | กำลังขุดอยู่ ("กำลังรีเสิร์ช…") | `start` |
| `checking` | รวมผลแล้วแต่ยังไม่ตรวจรอบสุดท้าย ("กำลังตรวจ") | `merge` ตั้งให้โหนดใหม่และโหนดพ่อแม่ |
| `done` | ตรวจแล้ว มีลูก | `mark-checked` |
| `frontier` | ตรวจแล้ว เป็นใบ กดขุดต่อได้ | `mark-checked` (และ `finish` เมื่อขุดแล้วไม่ได้ `merge`) |

### claim: `points`, `conflicts`, `counterpoints`

| ช่อง | ใช้กับ | ความหมาย |
|---|---|---|
| `text` | ทั้งสามรายการ | หนึ่งข้อความต่อหนึ่ง claim ห้ามว่าง |
| `cites` | ทั้งสามรายการ | id แหล่งอย่างน้อย 1 รายการ ทุกตัวต้องมีอยู่ใน `sources` ใน fragment ใช้ local id |
| `type` | `points` เท่านั้น | `fact` ข้อเท็จจริง, `opinion` ความเห็น, `estimate` ค่าประมาณ (rigor.md ข้อ 6) |
| `key` | `points` | `true` คือข้อสำคัญ ต้องมี `cites` ที่ต่างกันอย่างน้อย 2 รายการ หรือ `singleSource: true` |
| `singleSource` | `points` และ `findings` | `true` คือมีแหล่งเดียวโดยตั้งใจ หน้าแผนที่ติดป้าย "แหล่งเดียว" |

## 3. แหล่ง (`sources`)

| ช่อง | ความหมาย |
|---|---|
| `id` | `s1`, `s2`, … `merge` ตั้งให้ ใน fragment คือ local id ที่ตั้งเองได้ |
| `title` | ชื่อหน้าตามที่เปิดอ่านจริง ห้ามว่าง |
| `url` | ขึ้นต้นด้วย `http://` หรือ `https://` และเป็น URL ที่เปิดอ่านจริง |
| `publisher` | ผู้เผยแพร่ เช่น `MDN Web Docs` |
| `type` | `official`, `primary`, `secondary`, `community` หรือ `video` (ความหมายอยู่ใน rigor.md ข้อ 1) |
| `publishedAt` | วันที่เผยแพร่ ถ้าหน้าแสดงวันที่ รูป `YYYY-MM-DD` ถ้าหน้าแสดงแค่เดือนกับปีให้เขียน `YYYY-MM` และแสดงแค่ปีให้เขียน `YYYY` ห้ามเติมวันเอง หน้าที่ไม่แสดงวันที่ไม่ต้องใส่ ห้ามเดา |
| `accessedAt` | วันที่เปิดอ่าน รูป `YYYY-MM-DD` ต้องมีเสมอ |

หน้าแผนที่ติดป้าย "เก่ากว่า 2 ปี" ให้แหล่งที่ `publishedAt` เก่ากว่า `accessedAt` เกิน 2 ปี เอง ป้ายนี้ทำงานได้ก็ต่อเมื่อบันทึก `publishedAt` ไว้ (rigor.md ข้อ 4)

## 4. Fragment

Fragment คือสิ่งที่ผู้ช่วยรีเสิร์ชหนึ่งตัวเขียนต่อหนึ่งกลุ่ม ไปที่ `fragments/<groupId>.json` ในโฟลเดอร์ของหัวข้อ แล้ว Claude หลักรวมด้วย `merge <dir> --parent <groupId> --fragment <ไฟล์>`

```text
Fragment     = { sources: { <localId>: Source }, self?: NodeFields, children?: FragmentNode[] }
NodeFields   = { summary, why, points, conflicts, counterpoints, forYou, confidence, confidenceReason, logo, related }
FragmentNode = NodeFields & { title, level?: "group" | "item" (ค่าเริ่มต้น item), children?: FragmentNode[] }
```

สิ่งที่ `merge` ทำ:

- **แหล่ง:** `localId` ตั้งชื่ออะไรก็ได้ ใช้ในไฟล์นี้เท่านั้น `merge` เปลี่ยนเป็น id สากล `s<N>` ต่อจากเลขสูงสุดในแผนที่ URL ที่ตรงกับแหล่งที่มีอยู่แล้ว (เทียบโดยไม่นับตัวพิมพ์ของ scheme กับ host ไม่นับ `#hash` และ `/` ท้ายสุด แต่นับ query) จะใช้แหล่งเดิม ไม่สร้างซ้ำ และ record เดิมไม่ถูกแก้
- **cites:** `cites` อ้าง local id ที่ไม่มีใน `sources` ของไฟล์เดียวกันทำให้ merge ล้มเหลว (`unknown cite "x"`) id ที่ซ้ำกันในรายการเดียวถูกยุบเป็นหนึ่ง และ URL สองรายการที่ merge ถือว่าเป็นหน้าเดียวกันก็นับเป็นแหล่งเดียว
- **children:** โหนดใหม่ต่อท้ายลูกเดิม ได้ id `<id พ่อแม่>-<ลำดับ>` สถานะ `checking` และ `researchedAt` เป็นเวลาที่รวม ส่วน `id`, `status`, `researchedAt` และ `expansions` ที่ใส่มาใน fragment จะไม่ถูกใช้
- **self:** เขียนทับ field ของโหนดพ่อแม่ field ละทั้งก้อน ถ้า `self.points` มี 3 ข้อ โหนดจะเหลือ 3 ข้อนั้น (ข้อเดิมหายหมด) field ที่ไม่ใส่คงเดิม โหนดพ่อแม่ได้ `checking` และ `researchedAt` ใหม่ทุกครั้งที่ merge แม้ไม่ใส่ `self` ถ้าจะเพิ่มโดยไม่ลบของเดิม ให้ใส่ข้อเดิมซ้ำด้วย และคัดลอกแหล่งของข้อเดิมจาก `map.json` มาไว้ใน `sources` ของ fragment (URL เดียวกันจะใช้แหล่งเดิม ใช้ id เดิม เช่น `s3` เป็น local id ได้เลย ส่วนแหล่งใหม่ให้ตั้ง local id ที่ไม่ซ้ำกับ id เดิมใน `map.json` เช่น `n1` จะได้ไม่สับสน)
- **ทั้งหมดหรือไม่มีเลย:** ข้อผิดพลาดใดก็ตามทำให้ไม่บันทึกอะไร หลังรวม `dr.cjs` รัน `validateMap` ทั้งแผนที่ ถ้าไม่ผ่านก็ไม่บันทึก และพิมพ์ `errors` (ตารางด้านล่าง)

สิ่งที่ตรวจตอน `merge` (ผู้ช่วยต้องทำให้ครบ เพื่อให้รวมผ่านในครั้งเดียว):

1. ทุกแหล่ง: `url` ขึ้นต้นด้วย `http://` หรือ `https://`, `title` ไม่ว่าง, `type` เป็นหนึ่งในห้าชนิด, `accessedAt` เป็นวันที่ที่อ่านได้ (`publishedAt` ไม่ถูกตรวจ แต่ถ้าอ่านวันที่ไม่ได้ หน้าแผนที่จะไม่ติดป้ายอายุของแหล่งนั้น)
2. ทุก `points`, `conflicts`, `counterpoints`: `text` ไม่ว่าง และ `cites` มีอย่างน้อย 1 id ที่มีอยู่ใน `sources` ของไฟล์
3. ทุก `points`: `type` เป็น `fact`, `opinion` หรือ `estimate`
4. `points` ที่ `key: true`: `cites` ต่างกันอย่างน้อย 2 รายการ หรือ `singleSource: true` (อ้างแหล่งเดิมสองครั้งไม่นับเป็นสองแหล่ง)
5. โหนดที่มี `points` (รวมถึง `self`) ต้องมี `confidence` เป็น `high`, `medium` หรือ `low` และ `confidenceReason` ไม่ว่าง
6. ทุกโหนดใน `children` มี `title` ไม่ว่าง และ `level` (ถ้าใส่) เป็น `group` หรือ `item`
7. `related` ชี้เฉพาะ id ที่มีอยู่ในแผนที่แล้ว เช่น `g-do-2` อย่าเดา id ของโหนดที่เพิ่งสร้างหรือที่ผู้ช่วยตัวอื่นกำลังสร้าง
8. ไฟล์เป็น JSON ที่ถูกต้อง: ไม่มี comment ไม่มีเครื่องหมายจุลภาคเกิน และข้อความที่มีเครื่องหมายคำพูดตรง `"` ต้องใช้ `\"` หรือเปลี่ยนเป็นเครื่องหมายคำพูดไทย

เมื่อ `merge` ล้มเหลวจะพิมพ์ `{"error": …}` และ exit 1 โดยไม่บันทึกอะไร ข้อความที่พบบ่อยและวิธีแก้ (path ใน `errors` เช่น `root.children[0].children[0].children[0]` ชี้โหนดใหม่ตามลำดับในต้นไม้ และ id ของแหล่ง เช่น `sources.s5` เป็น id สากล ที่เรียงตามลำดับที่ประกาศใน `sources` ของไฟล์ต่อจากเลขสูงสุดเดิม):

| ข้อความ | สาเหตุ | วิธีแก้ |
|---|---|---|
| `unknown cite "s9"` | `cites` อ้าง local id ที่ไม่มีใน `sources` ของไฟล์ | เพิ่มแหล่งนั้นใน `sources` หรือแก้ id |
| `…points[0]: key point needs 2 sources or singleSource` | point `key: true` มี id ต่างกันไม่ถึง 2 (รวมกรณีสอง id ที่ชี้ URL เดียวกัน) | หาแหล่งที่สองที่เป็นอิสระ หรือใส่ `singleSource: true` พร้อมลดความมั่นใจ |
| `…confidence: must be one of high, medium, low when a checking node has points` และ `…confidenceReason: must be non-empty …` | โหนดมี `points` แต่ไม่มี `confidence` หรือเหตุผล | เติมทั้งสองช่อง |
| `…points[0].type: must be one of fact, opinion, estimate` | ป้ายชนิดของ point ผิด | แก้เป็นหนึ่งในสามชนิด |
| `…related[0]: unknown node "g-nope-9"` | `related` ชี้ id ที่ยังไม่มีในแผนที่ | ลบออก หรือใช้ id ที่มีอยู่ |
| `sources.s1.accessedAt: must be a date string` | แหล่งไม่มีวันที่เข้าถึง หรืออ่านวันที่ไม่ได้ | ใส่ `YYYY-MM-DD` |
| `sources.s1.url: must start with http:// or https://` | URL ไม่ครบรูป | ใช้ URL เต็มที่เปิดอ่านจริง |
| `fragment node needs a title` | โหนดใน `children` ไม่มี `title` | ใส่ `title` |
| `fragment file … is not valid JSON: …` | ไฟล์ไม่ใช่ JSON ที่ถูกต้อง | แก้ JSON (เครื่องหมาย `"` ในข้อความ จุลภาคเกิน comment) |

ตัวอย่างต่อไปนี้คือ fragment ของกลุ่ม `g-know-1` (ภาพรวม) ของหัวข้อ "ทำเว็บ 3D ระดับ Awwwards" ใช้เป็นแบบ ทุกแหล่งในตัวอย่างเป็นหน้าจริงที่เปิดอ่านแล้วเมื่อ 2 พ.ย. 2026 และข้อความตรงกับที่หน้านั้นเขียน แสดงครบทั้งสามชนิดของ point สามระดับความมั่นใจ ข้อสำคัญที่มีสองแหล่งอิสระและข้อสำคัญที่มีแหล่งเดียว (`singleSource`) ข้อโต้แย้ง แหล่งเก่า (กระทู้ปี 2018 ซึ่งหน้าแผนที่จะติดป้าย "เก่ากว่า 2 ปี") และโหนดที่ซ้อนกันสองชั้น ตัวอย่างนี้ไม่มี `conflicts` กับ `forYou` ดูวิธีเขียน `conflicts` ใน rigor.md ข้อ 5 ส่วน `forYou` เขียนตอนสังเคราะห์

```json
{
  "sources": {
    "s1": {
      "title": "Awwwards - Evaluation System",
      "url": "https://www.awwwards.com/about-evaluation/",
      "publisher": "Awwwards",
      "type": "official",
      "accessedAt": "2026-11-02"
    },
    "s2": {
      "title": "WebGL: 2D and 3D graphics for the web - Web APIs | MDN",
      "url": "https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API",
      "publisher": "MDN Web Docs",
      "type": "secondary",
      "publishedAt": "2026-10-30",
      "accessedAt": "2026-11-02"
    },
    "s3": {
      "title": "WebGL - Low-Level 3D Graphics API Based on OpenGL ES",
      "url": "https://www.khronos.org/webgl/",
      "publisher": "Khronos Group",
      "type": "official",
      "accessedAt": "2026-11-02"
    },
    "s4": {
      "title": "GitHub - mrdoob/three.js: JavaScript 3D Library. · GitHub",
      "url": "https://github.com/mrdoob/three.js",
      "publisher": "three.js (GitHub)",
      "type": "official",
      "accessedAt": "2026-11-02"
    },
    "s5": {
      "title": "Building up a basic demo with Three.js - Game development | MDN",
      "url": "https://developer.mozilla.org/en-US/docs/Games/Techniques/3D_on_the_web/Building_up_a_basic_demo_with_Three.js",
      "publisher": "MDN Web Docs",
      "type": "secondary",
      "publishedAt": "2026-08-05",
      "accessedAt": "2026-11-02"
    },
    "s6": {
      "title": "Why is 3D so rarely seen on the web? - Discussion - three.js forum",
      "url": "https://discourse.threejs.org/t/why-is-3d-so-rarely-seen-on-the-web/5377",
      "publisher": "three.js forum",
      "type": "community",
      "publishedAt": "2018-12-16",
      "accessedAt": "2026-11-02"
    },
    "s7": {
      "title": "WebGL - 3D Canvas graphics | Can I use... Support tables for HTML5, CSS3, etc",
      "url": "https://caniuse.com/webgl",
      "publisher": "Can I use",
      "type": "secondary",
      "accessedAt": "2026-11-02"
    }
  },
  "self": {
    "summary": "ภาพรวมของงานเว็บ 3D ระดับรางวัล: รางวัลให้คะแนนจากอะไร และเบราว์เซอร์วาด 3D ด้วยอะไร"
  },
  "children": [
    {
      "title": "เว็บระดับ Awwwards ตัดสินจากอะไร",
      "summary": "Awwwards ให้คะแนนเว็บจาก 4 ด้านที่น้ำหนักไม่เท่ากัน ดีไซน์หนักที่สุด รองลงมาคือการใช้งาน",
      "why": "บอกว่าควรลงแรงตรงไหนก่อน เพราะดีไซน์กับการใช้งานรวมกันเป็น 70% ของคะแนน",
      "points": [
        {
          "text": "คะแนนแบ่งเป็น ดีไซน์ 40%, การใช้งาน (usability) 30%, ความคิดสร้างสรรค์ 20% และเนื้อหา 10%",
          "type": "fact",
          "key": true,
          "singleSource": true,
          "cites": ["s1"]
        },
        {
          "text": "เว็บที่ผ่านการอนุมัติจะถูกส่งให้คณะกรรมการอย่างน้อย 18 คน ระบบตัดคะแนนที่ห่างจากค่าเฉลี่ยที่สุด 3 ค่าออกโดยอัตโนมัติ และนับเฉพาะโหวตของผู้ใช้ระดับ Professional ที่ผ่านการตรวจสอบ",
          "type": "fact",
          "cites": ["s1"]
        }
      ],
      "confidence": "medium",
      "confidenceReason": "ตัวเลขและขั้นตอนทั้งหมดมาจากหน้าทางการของ Awwwards แหล่งเดียว ไม่มีแหล่งอิสระให้เทียบ และหน้านี้ไม่ระบุวันที่ จึงให้ระดับกลาง",
      "related": ["g-see-3"]
    },
    {
      "title": "ใช้อะไรวาด 3D บนเว็บ",
      "summary": "เบราว์เซอร์วาด 3D ผ่านมาตรฐาน WebGL ส่วน Three.js เป็นไลบรารีที่ช่วยให้เขียนงาน 3D ง่ายขึ้น",
      "children": [
        {
          "title": "WebGL",
          "logo": "webgl",
          "summary": "ชั้นล่างสุดที่เบราว์เซอร์ให้มาสำหรับวาด 3D โดยไม่ต้องติดตั้งอะไรเพิ่ม",
          "points": [
            {
              "text": "WebGL เป็น API สำหรับวาดกราฟิก 3D ในเบราว์เซอร์โดยไม่ต้องติดตั้งปลั๊กอิน",
              "type": "fact",
              "key": true,
              "cites": ["s2", "s3"]
            },
            {
              "text": "WebGL อิงมาตรฐาน OpenGL ES และเรียกใช้จาก JavaScript ผ่านองค์ประกอบ canvas ของ HTML",
              "type": "fact",
              "cites": ["s2", "s3"]
            },
            {
              "text": "WebGL เป็นมาตรฐานเปิดที่ไม่เสียค่าลิขสิทธิ์",
              "type": "fact",
              "cites": ["s3"]
            },
            {
              "text": "เบราว์เซอร์รองรับอย่างเดียวไม่พอ เครื่องของผู้ใช้ต้องมีฮาร์ดแวร์ที่รองรับด้วย",
              "type": "fact",
              "cites": ["s2"]
            },
            {
              "text": "เบราว์เซอร์ที่รองรับ WebGL คิดเป็นราว 97.5% ของการใช้งานทั่วโลก (สัดส่วนการใช้งานเดือนกันยายน 2026)",
              "type": "estimate",
              "key": true,
              "singleSource": true,
              "cites": ["s7"]
            }
          ],
          "confidence": "medium",
          "confidenceReason": "นิยามและที่มาของ WebGL มีสองแหล่งอิสระยืนยันตรงกัน (เอกสาร Khronos และ MDN) แต่ตัวเลขสัดส่วนการรองรับมาจาก caniuse แหล่งเดียว จึงให้ระดับกลาง"
        },
        {
          "title": "Three.js",
          "logo": "threedotjs",
          "summary": "ไลบรารี JavaScript ที่ช่วยเขียนงาน 3D ให้ง่ายขึ้น",
          "points": [
            {
              "text": "Three.js เป็นไลบรารี JavaScript สำหรับงาน 3D ที่ช่วยให้ทำงานง่ายและเร็วขึ้น โปรเจกต์ตั้งเป้าให้ใช้ง่าย และ MDN ระบุว่ามีฟังก์ชันช่วยให้ทำงาน 3D ทั่วไปได้เร็วขึ้น",
              "type": "fact",
              "key": true,
              "cites": ["s4", "s5"]
            },
            {
              "text": "สำหรับรูปทรงพื้นฐาน Three.js จัดการรายละเอียดอย่างการสร้างจุดยอดและหน้าให้ นักพัฒนาจึงโฟกัสโค้ดระดับสูงได้",
              "type": "fact",
              "cites": ["s5"]
            },
            {
              "text": "โปรเจกต์ตั้งเป้าให้น้ำหนักเบาและทำงานได้หลายเบราว์เซอร์ บิลด์ปัจจุบันมี renderer ให้เลือก WebGL และ WebGPU ส่วน SVG กับ CSS3D มีเป็นส่วนเสริม",
              "type": "fact",
              "cites": ["s4"]
            },
            {
              "text": "MDN มองว่า Three.js เป็นหนึ่งในไลบรารี WebGL ที่นิยมที่สุด แต่ระบุว่าไม่ได้แปลว่าดีกว่าไลบรารีอื่น",
              "type": "opinion",
              "cites": ["s5"]
            }
          ],
          "confidence": "high",
          "confidenceReason": "ข้อสำคัญมีสองแหล่งอิสระ คือหน้าโปรเจกต์เองกับเอกสาร MDN ซึ่งพูดถึงด้านเดียวกัน (ช่วยให้ทำงาน 3D ง่ายและเร็วขึ้น) ส่วนข้อ renderer มาจากหน้าโปรเจกต์ซึ่งเป็นต้นทางของข้อมูล และข้อ \"นิยมที่สุด\" ติดป้ายเป็นความเห็นของ MDN"
        }
      ]
    },
    {
      "title": "คนทำงานจริงมองเว็บ 3D อย่างไร",
      "summary": "กระทู้ในฟอรัม three.js ปี 2018 มองว่าต้นทุนสูงและเว็บส่วนใหญ่ยังไม่มีเหตุผลต้องใช้ 3D แต่มีคนรายงานว่าใช้งานได้ลื่นบนมือถือรุ่นเก่า",
      "points": [
        {
          "text": "ผู้ร่วมกระทู้คนหนึ่งมองว่าเว็บ 3D ยังน้อยเพราะต้นทุน อีกคนมองว่าเว็บส่วนใหญ่ไม่มีเหตุผลคุ้มพอที่จะใช้ 3D",
          "type": "opinion",
          "cites": ["s6"]
        }
      ],
      "counterpoints": [
        {
          "text": "ผู้ร่วมกระทู้อีกคนรายงานว่าหน้า 3D ของตัวเองที่มีแอนิเมชัน morph target และเงาทำงานลื่นบนมือถือรุ่นเก่า เพื่อนราว 40 คนตอบว่าลื่น ล้มเหลวเพียงเครื่องเดียว แต่ทดสอบบน 3G ที่จำกัดความเร็วแล้วกว่าจะเห็นหน้าแรกใช้เวลาราว 10 วินาที",
          "cites": ["s6"]
        }
      ],
      "confidence": "low",
      "confidenceReason": "ทั้งโหนดมาจากกระทู้ในฟอรัมแหล่งเดียว เป็นความเห็นและประสบการณ์ส่วนตัว และเก่ากว่า 2 ปี (ธ.ค. 2018) จึงให้ระดับต่ำ ใช้เป็นประเด็นให้ตรวจเพิ่ม ไม่ใช่ข้อสรุป",
      "related": ["g-warn-3"]
    }
  ]
}
```

เมื่อรวมใต้ `g-know-1` แล้ว id ที่ได้คือ `g-know-1-1` (เกณฑ์ Awwwards), `g-know-1-2` (ใช้อะไรวาด 3D) พร้อมลูก `g-know-1-2-1` (WebGL) และ `g-know-1-2-2` (Three.js), และ `g-know-1-3` (คนทำงานจริง) แหล่ง `s1`–`s7` ได้ id สากลเดียวกันเมื่อแผนที่ยังไม่มีแหล่งใดมาก่อน

## 5. ไฟล์ `synthesize`

ฟิลด์ที่ไม่มี `merge` ไหนเขียนถึง (สรุป 1 นาที ลำดับการอ่าน คำแนะนำ "สำหรับคุณ" และสรุปของโหนดราก) เขียนด้วย `node "<skill_dir>/scripts/dr.cjs" synthesize <dir> --file <ไฟล์>` ไฟล์เป็น JSON object ที่มีอย่างน้อยหนึ่งในสี่ key นี้ key อื่นทำให้คำสั่งปฏิเสธ

| key | ค่า | ผล |
|---|---|---|
| `summary` | `{ findings, startTomorrow }` | แทนที่ `summary` ของไฟล์ทั้งก้อน `findings` ไม่เกิน 5 ข้อ ข้อละ `{ text, cites, singleSource? }` ที่ต้องมี `cites` ต่างกันอย่างน้อย 2 รายการหรือ `singleSource: true` `startTomorrow` ไม่เกิน 3 ข้อ เป็นข้อความ |
| `readingPath` | รายการ id โหนด | แทนที่ลำดับการอ่านทั้งก้อน ของจริง 8–12 โหนด ทุก id ต้องมีอยู่ในแผนที่ |
| `forYou` | `{ "<id โหนด>": "ข้อความ" }` | ตั้ง `forYou` ของแต่ละโหนด ข้อความห้ามว่าง และ id ต้องมีอยู่ |
| `rootSummary` | ข้อความ | ตั้ง `summary` ของโหนดราก (หน้าแผนที่แสดงเหนือสรุป 1 นาที) ห้ามว่าง |

`cites` ใน `findings` เป็น id สากลใน `map.json` (`s1`, `s2`, …) ไม่ใช่ local id ของ fragment ให้อ่านจาก `sources` ใน `map.json` หลังรวมแล้ว คำสั่งนี้ไม่แตะ `status` และ `researchedAt` ของโหนดใด และถ้าแผนที่ที่ได้ไม่ผ่านการตรวจ จะไม่บันทึกอะไรและพิมพ์ `errors`

ตัวอย่างนี้ใช้ได้กับแผนที่ที่รวม fragment ด้านบนไว้ใต้ `g-know-1` แล้ว (ของจริงต้องมี `findings` 5 ข้อ `startTomorrow` 3 ข้อ และ `readingPath` 8–12 โหนด ที่นี่ย่อไว้):

```json
{
  "rootSummary": "เว็บ 3D ระดับรางวัลตัดสินที่ดีไซน์และการใช้งานเป็นหลัก ส่วนเทคนิคมาจาก WebGL ที่เบราว์เซอร์ให้มา โดยมีไลบรารีอย่าง Three.js ช่วยให้เขียนง่ายขึ้น",
  "summary": {
    "findings": [
      {
        "text": "WebGL คือฐานที่เบราว์เซอร์ให้มาสำหรับวาด 3D โดยไม่ต้องติดตั้งปลั๊กอิน",
        "cites": ["s2", "s3"]
      },
      {
        "text": "Awwwards ให้น้ำหนักดีไซน์ 40% และการใช้งาน 30% รวมกันเป็น 70% ของคะแนน",
        "cites": ["s1"],
        "singleSource": true
      }
    ],
    "startTomorrow": [
      "เปิดหน้า Evaluation System ของ Awwwards แล้วลองให้คะแนนเว็บที่ชอบ 3 เว็บด้วยเกณฑ์ 4 ด้านนั้น"
    ]
  },
  "readingPath": ["g-know-1-1", "g-know-1-2-1", "g-know-1-2-2", "g-know-1-3"],
  "forYou": {
    "g-know-1-1": "คุณตั้งเป้าสร้างงานเอง ให้ลงแรงที่ดีไซน์และการใช้งานก่อน (รวม 70% ของคะแนน) แล้วค่อยเพิ่ม 3D เท่าที่งานต้องการ"
  }
}
```

## 6. ไฟล์ brief สำหรับ `init`

`node "<skill_dir>/scripts/dr.cjs" init --slug <slug> --brief <ไฟล์> [--topic <หัวข้อ>] [--root <โฟลเดอร์>]` อ่านคำตอบของผู้ใช้จากไฟล์ JSON ที่เขียนด้วย Write tool (ข้อความของผู้ใช้จึงไม่ต้องผ่าน shell) ถ้าไม่ส่ง `--topic` จะใช้ `topic` ในไฟล์ ไฟล์ทั้งก้อนถูกเก็บเป็น `brief` ใน `map.json`

| ช่อง | ความหมาย |
|---|---|
| `topic` | ชื่อหัวข้อ |
| `goal` | เป้าหมาย เช่น "สร้างงาน", "ตัดสินใจ", "อยากเข้าใจ", "นำเสนอ" หรือข้อความของผู้ใช้เอง |
| `level` | พื้นฐานตอนนี้: "ไม่รู้เลย", "พอรู้บ้าง" หรือ "มีประสบการณ์" |
| `focus` | จุดที่อยากเน้น (ว่างได้) |
| `exclude` | สิ่งที่ไม่เอา (ว่างได้) |
| `depth` | `quick`, `standard` หรือ `deep` เป็นช่องเดียวที่ถูกตรวจ ความหมายอยู่ใน structure.md |
| `constraints` | ข้อจำกัด เช่น งบ เวลา แพลตฟอร์ม (ว่างได้) |

```json
{
  "topic": "ทำเว็บ 3D ระดับ Awwwards ต้องใช้อะไรบ้าง",
  "goal": "สร้างงาน",
  "level": "พอรู้บ้าง",
  "focus": "เครื่องมือและขั้นตอนการทำ",
  "exclude": "ไม่เอาเรื่องการตลาดและการส่งประกวด",
  "depth": "standard",
  "constraints": "ทำคนเดียว ไม่มีงบจ้างคน"
}
```
