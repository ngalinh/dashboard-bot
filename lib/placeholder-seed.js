const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const registry = require('./registry');

const AVATAR_DIR = path.join(__dirname, '..', 'assets', 'placeholder-avatars');
const ICONS_DIR = path.join(__dirname, '..', 'data', 'platform-bot-icons');

/** Marker lưu trong `status` để phân biệt bot layout-only với bot đã có source. */
const PLACEHOLDER_STATUS = 'placeholder';

/**
 * 7 bot theo design trong preview/Dashboard.html.
 * ID lấy từ sha1('platform-placeholder:<key>').slice(0, 16) → ổn định giữa các lần deploy.
 * File avatar tương ứng: assets/placeholder-avatars/<key>.png (extract từ preview bằng
 * scripts/extract-placeholder-avatars.js).
 */
const PLACEHOLDERS = [
  {
    key: 'mon',
    name: 'Bé Mon',
    dept: 'SALE',
    deptColor: '#8B5CF6',
    role: 'Phụ trách quản lý đơn hàng',
    tasks: ['Tạo đơn', 'Check status đơn', 'Báo đơn cancel', 'Nhắc đơn chưa hoàn thành'],
  },
  {
    key: 'xeko',
    name: 'Xeko',
    dept: 'SALE',
    deptColor: '#8B5CF6',
    role: 'Phụ trách làm content',
    tasks: ['Tìm các deal sale', 'Đăng post sale'],
  },
  {
    key: 'deki',
    name: 'Deki',
    dept: 'SALE',
    deptColor: '#8B5CF6',
    role: 'Quản lý data khách hàng',
    tasks: ['Lưu thông tin khách', 'Report về khách', 'Lọc khách quan tâm theo website/sp'],
  },
  {
    key: 'mi',
    name: 'Bé Mi',
    dept: 'CSKH',
    deptColor: '#10B981',
    role: 'Phụ trách báo hàng về',
    tasks: ['Gửi thông báo hàng về & nhắc khách', 'Tham chiếu từ hình ck screenshot'],
  },
  {
    key: 'nobita',
    name: 'Nobita',
    dept: 'MUA HÀNG',
    deptColor: '#F59E0B',
    role: 'Hỗ trợ mua hàng',
    tasks: ['Update tracking từ email', 'Gửi đơn mua hộ', 'Report đơn pending'],
  },
  {
    key: 'chaien',
    name: 'Chaien',
    dept: 'KHO',
    deptColor: '#F97316',
    role: 'Hỗ trợ kho hàng',
    tasks: ['Report hàng hoá'],
  },
  {
    key: 'xuka',
    name: 'Xuka',
    dept: 'KẾ TOÁN',
    deptColor: '#0EA5E9',
    role: 'Kế toán',
    tasks: ['Nhập các khoản Thu chi', 'Chấm công', 'Nhắc công nợ cskh', 'Tính lương'],
  },
];

function placeholderId(key) {
  return crypto.createHash('sha1').update(`platform-placeholder:${key}`).digest('hex').slice(0, 16);
}

function listPlaceholderIds() {
  return PLACEHOLDERS.map((p) => placeholderId(p.key));
}

function iconVariants(botId) {
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].map((ext) => path.join(ICONS_DIR, `${botId}.${ext}`));
}

function ensureIconCopied(botId, srcPng) {
  if (iconVariants(botId).some((p) => fs.existsSync(p))) return;
  if (!fs.existsSync(srcPng)) return;
  if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });
  fs.copyFileSync(srcPng, path.join(ICONS_DIR, `${botId}.png`));
}

/**
 * Tạo bot placeholder cho các entry chưa có trong registry. Không ghi đè bot đã tồn tại.
 * Chạy một lần khi start server, an toàn gọi nhiều lần (idempotent).
 */
async function ensurePlaceholderSeed() {
  const existing = new Set(registry.readRegistry().bots.map((b) => b.id));
  let created = 0;
  for (const p of PLACEHOLDERS) {
    const id = placeholderId(p.key);
    const srcPng = path.join(AVATAR_DIR, `${p.key}.png`);
    if (existing.has(id)) {
      // Bot đã seed trước đó — vẫn đảm bảo icon tồn tại (khi deploy lần đầu registry có
      // rồi nhưng icons dir bị mount volume rỗng).
      ensureIconCopied(id, srcPng);
      continue;
    }
    await registry.addBot({
      id,
      name: p.name,
      description: '',
      allowedRoleNames: [],
      dept: p.dept,
      deptColor: p.deptColor,
      role: p.role,
      tasks: p.tasks,
      enabled: true,
      status: PLACEHOLDER_STATUS,
      port: null,
      workDir: null,
      statusMessage: '',
    });
    ensureIconCopied(id, srcPng);
    created += 1;
  }
  if (created > 0) {
    console.log(`[platform] Placeholder seed: tạo ${created} bot layout từ design preview.`);
  }
}

module.exports = {
  PLACEHOLDER_STATUS,
  ensurePlaceholderSeed,
  listPlaceholderIds,
  placeholderId,
};
