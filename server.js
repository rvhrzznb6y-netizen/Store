require('dotenv').config();
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const morgan      = require('morgan');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const axios       = require('axios');
const nodemailer  = require('nodemailer');
const crypto      = require('crypto');
const Database    = require('better-sqlite3');
const path        = require('path');
const fs          = require('fs');

try { require('cookie-parser'); } catch {}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Local Database (SQLite) ──────────────────────
let db;
function openDB() {
  if (db) return db;
  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'soe.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

function normalizeSQL(sql) {
  let s = String(sql).trim();

  s = s.replace(/\bINSERT\s+IGNORE\s+INTO\b/gi, 'INSERT OR IGNORE INTO');
  s = s.replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP');
  s = s.replace(/\bTRUE\b/gi, '1');
  s = s.replace(/\bFALSE\b/gi, '0');
  s = s.replace(/\bCREATE\s+OR\s+REPLACE\s+VIEW\b/gi, 'CREATE VIEW IF NOT EXISTS');

  // SQLite-friendly types in any remaining DDL
  s = s.replace(/ENGINE=InnoDB/gi, '');
  s = s.replace(/\bAUTO_INCREMENT\b/gi, 'AUTOINCREMENT');
  s = s.replace(/\bBIGINT UNSIGNED\b/gi, 'INTEGER');
  s = s.replace(/\bINT UNSIGNED\b/gi, 'INTEGER');
  s = s.replace(/\bTINYINT\b/gi, 'INTEGER');
  s = s.replace(/\bDECIMAL\(\d+,\d+\)\b/gi, 'REAL');
  s = s.replace(/\bDATETIME\b/gi, 'TEXT');
  s = s.replace(/\bJSON\b/gi, 'TEXT');
  s = s.replace(/\bENUM\([^)]+\)\b/gi, 'TEXT');

  // A small compatibility tweak for the settings upsert
  s = s.replace(
    /INSERT\s+INTO\s+settings\s+\(key_name,value\)\s+VALUES\s+\(\?,\?\)\s+ON\s+DUPLICATE\s+KEY\s+UPDATE\s+value=\?,\s*updated_at=CURRENT_TIMESTAMP/i,
    "INSERT INTO settings (key_name,value) VALUES (?,?) ON CONFLICT(key_name) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"
  );

  // MySQL boolean comparisons
  s = s.replace(/=\s*TRUE\b/gi, '=1');
  s = s.replace(/=\s*FALSE\b/gi, '=0');
  return s;
}

function isSelect(sql) {
  return /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql);
}

function runSQL(sql, params = []) {
  const dbi = openDB();
  const q = normalizeSQL(sql);

  if (isSelect(q)) {
    return dbi.prepare(q).all(...params);
  }

  const stmt = dbi.prepare(q);
  const info = stmt.run(...params);
  return {
    insertId: Number(info.lastInsertRowid || 0),
    affectedRows: info.changes || 0,
  };
}

async function q(sql, params = []) {
  return runSQL(sql, params);
}

async function q1(sql, params = []) {
  const r = await q(sql, params);
  return r[0] || null;
}

async function tx(cb) {
  const dbi = openDB();
  const conn = {
    async execute(sql, params = []) {
      const qsql = normalizeSQL(sql);
      if (isSelect(qsql)) return [dbi.prepare(qsql).all(...params)];
      const info = dbi.prepare(qsql).run(...params);
      return [{
        insertId: Number(info.lastInsertRowid || 0),
        affectedRows: info.changes || 0,
      }];
    },
    async beginTransaction() { dbi.exec('BEGIN'); },
    async commit() { dbi.exec('COMMIT'); },
    async rollback() { dbi.exec('ROLLBACK'); },
    release() {},
  };

  await conn.beginTransaction();
  try {
    const r = await cb(conn);
    await conn.commit();
    return r;
  } catch (e) {
    await conn.rollback();
    throw e;
  }
}

// ── DB Setup — يُهيئ قاعدة البيانات تلقائياً ────
async function setupDB() {
  const dbi = openDB();

  dbi.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password_hash TEXT,
      role TEXT DEFAULT 'customer' CHECK(role IN ('customer','admin','reseller')),
      company_name TEXT,
      vat_number TEXT,
      is_active INTEGER DEFAULT 1,
      last_login TEXT,
      reset_token TEXT,
      reset_expires TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      icon TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      category_id INTEGER NOT NULL,
      vendor TEXT,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      description_ar TEXT,
      icon TEXT DEFAULT '📦',
      badge TEXT DEFAULT 'new',
      badge_label_ar TEXT,
      price_sar REAL NOT NULL,
      original_price_sar REAL,
      features TEXT,
      duration_type TEXT DEFAULT 'lifetime' CHECK(duration_type IN ('lifetime','annual','monthly')),
      redington_sku TEXT,
      stock_mode TEXT DEFAULT 'manual' CHECK(stock_mode IN ('api','manual','unlimited')),
      rating REAL DEFAULT 5.0,
      review_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      is_featured INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS license_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      key_value TEXT NOT NULL,
      status TEXT DEFAULT 'available' CHECK(status IN ('available','sold','failed')),
      source TEXT DEFAULT 'manual' CHECK(source IN ('redington','manual','import')),
      order_id INTEGER,
      sold_at TEXT,
      batch_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      user_id INTEGER,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT,
      customer_country TEXT DEFAULT 'SA',
      subtotal_sar REAL NOT NULL,
      discount_sar REAL DEFAULT 0,
      vat_rate REAL DEFAULT 15.00,
      vat_amount_sar REAL DEFAULT 0,
      total_sar REAL NOT NULL,
      coupon_code TEXT,
      coupon_discount REAL DEFAULT 0,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','processing','completed','failed','refunded','cancelled')),
      invoice_number TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      product_sku TEXT,
      quantity INTEGER DEFAULT 1,
      unit_price_sar REAL NOT NULL,
      total_price_sar REAL NOT NULL,
      license_key_id INTEGER,
      license_sent INTEGER DEFAULT 0,
      license_sent_at TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      provider TEXT DEFAULT 'moyasar',
      provider_payment_id TEXT,
      amount_sar REAL NOT NULL,
      payment_method TEXT,
      status TEXT DEFAULT 'initiated' CHECK(status IN ('initiated','paid','failed','refunded')),
      webhook_payload TEXT,
      refund_id TEXT,
      refund_reason TEXT,
      refund_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      discount_type TEXT DEFAULT 'percent' CHECK(discount_type IN ('percent','fixed')),
      discount_value REAL NOT NULL,
      max_uses INTEGER DEFAULT 1000,
      used_count INTEGER DEFAULT 0,
      min_order_sar REAL DEFAULT 0,
      expires_at TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key_name TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS email_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      recipient TEXT NOT NULL,
      subject TEXT,
      type TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('sent','failed','pending')),
      error TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_license_keys_product_status ON license_keys(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
  `);

  const cats = [
    ['os','أنظمة التشغيل','Operating Systems','🖥',1],
    ['office','أوفيس ومايكروسوفت','Microsoft Office','📄',2],
    ['creative','تصميم وإبداع','Creative & Design','🎨',3],
    ['security','الأمان والحماية','Security & Antivirus','🛡',4],
    ['dev','أدوات المطورين','Developer Tools','⚙️',5],
    ['edu','تعليم وتدريب','Education','📚',6],
  ];
  const insertCategory = dbi.prepare('INSERT OR IGNORE INTO categories (slug,name_ar,name_en,icon,sort_order) VALUES (?,?,?,?,?)');
  for (const row of cats) insertCategory.run(...row);

  const products = [
    ['WIN11PRO',1,'Microsoft','ويندوز 11 برو','Windows 11 Pro','أحدث ويندوز للأعمال — مدى الحياة','🪟','hot','🔥 الأكثر مبيعاً',94,750,'["1 PC","مدى الحياة"]','lifetime',1],
    ['WIN10PRO',1,'Microsoft','ويندوز 10 برو','Windows 10 Pro','الأكثر استقراراً — دعم حتى 2028','💻','pop','⭐ شائع',68,671,'["1 PC","مدى الحياة"]','lifetime',0],
    ['WIN11HOME',1,'Microsoft','ويندوز 11 هوم','Windows 11 Home','ويندوز 11 للمنازل','🖥','pop','⭐ شائع',75,521,'["1 PC","مدى الحياة"]','lifetime',0],
    ['WINSRV2022',1,'Microsoft','ويندوز سيرفر 2022','Windows Server 2022','خادم ويندوز للشركات','🗄','new','🆕 Server',150,3750,'["Server","مدى الحياة"]','lifetime',0],
    ['OFF2024PP',2,'Microsoft','أوفيس 2024 برو بلس','Office 2024 Pro Plus','أحدث إصدار أوفيس — 7 تطبيقات','📋','hot','🔥 2024',263,1650,'["1 PC","مدى الحياة","7 Apps"]','lifetime',1],
    ['OFF2021PP',2,'Microsoft','أوفيس 2021 برو بلس','Office 2021 Pro Plus','وورد إكسيل باوربوينت أوتلوك','📝','pop','⭐ الأكثر مبيعاً',188,1313,'["1 PC","مدى الحياة"]','lifetime',1],
    ['OFF2021HS',2,'Microsoft','أوفيس 2021 هوم ستيودنت','Office 2021 H&S','للطلاب والمنازل','🏠','sale','💛 تخفيض',131,559,'["1 PC","مدى الحياة"]','lifetime',0],
    ['OFF2019PP',2,'Microsoft','أوفيس 2019 برو بلس','Office 2019 Pro Plus','إصدار 2019 المستقر','📜','sale','💛 اقتصادي',113,938,'["1 PC","مدى الحياة"]','lifetime',0],
    ['M365P1Y',2,'Microsoft','مايكروسوفت 365 شخصي','Microsoft 365 Personal','+ 1TB OneDrive سنوي','☁️','pop','⭐ شائع',169,263,'["1 User","1 سنة","1TB Cloud"]','annual',0],
    ['M365F1Y',2,'Microsoft','مايكروسوفت 365 عائلي','Microsoft 365 Family','6 مستخدمين + 6TB Cloud','👨‍👩‍👧','new','👨‍👩‍👧 عائلي',281,375,'["6 Users","1 سنة"]','annual',0],
    ['M365BS',2,'Microsoft','مايكروسوفت 365 بيزنس','Microsoft 365 Business','للشركات الصغيرة + Teams','🏢','hot','🏢 أعمال',244,563,'["1 User","1 سنة","Teams"]','annual',0],
    ['MSPROJECT',2,'Microsoft','مايكروسوفت بروجكت 2021','MS Project 2021','إدارة المشاريع الاحترافية','📊','new','📊 مميز',169,2250,'["1 PC","مدى الحياة"]','lifetime',0],
    ['MSVISIO',2,'Microsoft','مايكروسوفت فيزيو 2021','MS Visio 2021','رسم المخططات الاحترافية','📐','new','📐 مميز',169,1875,'["1 PC","مدى الحياة"]','lifetime',0],
    ['ADB-ACRO',3,'Adobe','أدوبي أكروبات برو','Adobe Acrobat Pro DC','إنشاء وتحرير PDF احترافي','📄','hot','🔥 الأكثر طلباً',225,896,'["1 Device","1 سنة"]','annual',0],
    ['ADB-PS',3,'Adobe','أدوبي فوتوشوب','Adobe Photoshop CC','أقوى برنامج تحرير صور','🎨','pop','⭐ احترافي',169,746,'["1 Device","1 سنة"]','annual',0],
    ['ADB-PR',3,'Adobe','أدوبي بريمير برو','Adobe Premiere Pro','تحرير فيديو احترافي','🎬','pop','⭐ محترف',169,746,'["1 Device","1 سنة"]','annual',0],
    ['ADB-LR',3,'Adobe','أدوبي لايت روم','Adobe Lightroom Classic','تعديل الصور الفوتوغرافية','📷','sale','💛 تخفيض',131,446,'["1 Device","1 سنة"]','annual',0],
    ['ADB-CC',3,'Adobe','أدوبي كريتف كلاود','Adobe Creative Cloud All','جميع تطبيقات Adobe 20+','🌟','hot','🔥 الباقة الكاملة',675,2250,'["2 Devices","1 سنة","20+ App"]','annual',0],
    ['AUTOCAD25',3,'Autodesk','أوتوكاد 2025','AutoCAD 2025','التصميم الهندسي 2D/3D','📐','sale','💛 توفير كبير',281,7031,'["1 PC","1 سنة"]','annual',0],
    ['COREL24',3,'Corel','كوريل درو 2024','CorelDRAW 2024','تصميم الجرافيك الاحترافي','🖌','new','🆕 2024',244,1125,'["1 PC","1 سنة"]','annual',0],
    ['KAS-PLUS1',4,'Kaspersky','كاسبرسكي بلس','Kaspersky Plus 1 PC','حماية + VPN + مدير كلمات','🛡','hot','🔥 الأفضل',75,188,'["1 PC","1 سنة","VPN+"]','annual',1],
    ['KAS-TOT3',4,'Kaspersky','كاسبرسكي للعائلة 3','Kaspersky Total 3 PC','حماية شاملة 3 أجهزة','🔐','pop','⭐ عائلي',105,300,'["3 PC","1 سنة"]','annual',0],
    ['BDF-TOT5',4,'Bitdefender','بيتدفندر توتال 5','Bitdefender Total 5 PC','الحماية الكاملة 5 أجهزة','🔒','pop','⭐ الأكثر مبيعاً',94,263,'["5 PC","1 سنة"]','annual',0],
    ['NOR360D',4,'Norton','نورتون 360 ديلوكس','Norton 360 Deluxe 5','VPN + Backup + Dark Web','🟡','sale','💛 شامل',94,375,'["5 Devices","1 سنة"]','annual',0],
    ['ESET-IS',4,'ESET','إيسيت إنترنت سيكيوريتي','ESET Internet Security','حماية خفيفة فائقة','🟢','pop','⭐ خفيف',86,225,'["1 PC","1 سنة"]','annual',0],
    ['MWB-PREM',4,'Malwarebytes','مالواربيتس بريميوم','Malwarebytes Premium','ضد البرامج الضارة','🔵','new','🆕 Anti-Malware',75,169,'["1 PC","1 سنة"]','annual',0],
    ['NORD1Y',4,'NordVPN','نورد VPN سنة','NordVPN 1Y 6 Devices','أسرع VPN — 5400 خادم','🌐','hot','🔥 VPN #1',188,375,'["6 Devices","1 سنة"]','annual',0],
    ['EXPR1Y',4,'ExpressVPN','إكسبريس VPN سنة','ExpressVPN 1Y 5 Devices','VPN فائق السرعة','⚡','pop','⭐ سريع',225,450,'["5 Devices","1 سنة"]','annual',0],
    ['MCAF-TOT5',4,'McAfee','ماكافي توتال 5','McAfee Total 5 Devices','حماية + تحسين الأداء','🔴','sale','💛 توفير',86,338,'["5 Devices","1 سنة"]','annual',0],
    ['JB-ALL',5,'JetBrains','جيت برينز كل المنتجات','JetBrains All Products','IntelliJ+PyCharm+WebStorm','⚙️','hot','🔥 للمطورين',281,938,'["1 User","1 سنة","All IDEs"]','annual',0],
    ['JB-IJ',5,'JetBrains','إنتيلج آيديا الترا','IntelliJ IDEA Ultimate','أفضل IDE لـ Java/Kotlin','☕','pop','⭐ Java Dev',169,938,'["1 User","1 سنة"]','annual',0],
    ['JB-PC',5,'JetBrains','بايتشارم برو','PyCharm Professional','IDE لبايثون وعلم البيانات','🐍','pop','⭐ Python',131,746,'["1 User","1 سنة"]','annual',0],
    ['VMW-PRO',5,'VMware','VMware Workstation Pro 17','VMware Workstation Pro','تشغيل أنظمة متعددة','🖥','new','🆕 Virtual',225,746,'["1 PC","مدى الحياة"]','lifetime',0],
    ['PAR-DES19',5,'Parallels','بارالي ديسكتوب 19','Parallels Desktop 19 Mac','Windows على Mac M1/M2/M3','🍎','new','🍎 Mac Only',263,563,'["1 Mac","1 سنة"]','annual',0],
    ['SQL-SVR22',5,'Microsoft','SQL سيرفر 2022','SQL Server 2022 Standard','قاعدة بيانات مايكروسوفت','🗃','new','🆕 Database',188,3375,'["Server","مدى الحياة"]','lifetime',0],
    ['ROSETTA',6,'Rosetta Stone','روستا ستون 5 لغات','Rosetta Stone 5 Languages','تعلم 5 لغات مدى الحياة','🌐','sale','💛 تعليم',131,671,'["5 Languages","مدى الحياة"]','lifetime',0],
    ['M365-EDU',6,'Microsoft','أوفيس 365 تعليمي','Microsoft 365 Education','للطلاب والمؤسسات التعليمية','🎓','sale','💛 طلابي',113,263,'["1 Student","1 سنة"]','annual',0],
    ['ADB-EDU',6,'Adobe','أدوبي CC التعليمي','Adobe Creative Cloud EDU','جميع Adobe للطلاب','🖼','pop','⭐ طلابي',338,1125,'["1 Device","1 سنة"]','annual',0],
    ['AUT-EDU',6,'Autodesk','أوتوكاد تعليمي 2025','AutoCAD 2025 Education','AutoCAD للطلاب','🏗','sale','💛 طلابي',150,7031,'["1 PC","1 سنة"]','annual',0],
  ];
  const insertProduct = dbi.prepare('INSERT OR IGNORE INTO products (sku,category_id,vendor,name_ar,name_en,description_ar,icon,badge,badge_label_ar,price_sar,original_price_sar,features,duration_type,is_featured) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const row of products) insertProduct.run(...row);

  const insertSetting = dbi.prepare('INSERT OR IGNORE INTO settings (key_name,value) VALUES (?,?)');
  const defaultSettings = [
    ['store_name_ar','SOE — Springs Of Expertise'],
    ['cr_number',''],['vat_number',''],['vat_rate','15'],
    ['support_email','support@soe-software.com'],
    ['whatsapp_number','+966500000000'],
    ['moyasar_live_mode','false'],
    ['auto_deliver_keys','true'],
  ];
  for (const row of defaultSettings) insertSetting.run(...row);

  dbi.prepare("INSERT OR IGNORE INTO coupons (code,discount_type,discount_value,max_uses) VALUES ('SOE25','percent',10,1000),('WELCOME15','percent',15,500)").run();

  const admin = dbi.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (!admin) {
    const hash = await bcrypt.hash('Admin123!', 12);
    dbi.prepare("INSERT INTO users (name,email,password_hash,role,is_active) VALUES ('المدير','admin@soe.com',?,'admin',1)").run(hash);
    console.log('✅ Admin created: admin@soe.com / Admin123!');
  }

  try {
    dbi.exec(`
      DROP VIEW IF EXISTS v_order_summary;
      CREATE VIEW v_order_summary AS
        SELECT o.id,o.order_number,o.customer_name,o.customer_email,
               o.total_sar,o.status,o.created_at,
               p.status AS payment_status,p.payment_method,
               COUNT(oi.id) AS item_count
        FROM orders o
        LEFT JOIN payments p ON p.order_id=o.id
        LEFT JOIN order_items oi ON oi.order_id=o.id
        GROUP BY o.id,p.id;

      DROP VIEW IF EXISTS v_license_inventory;
      CREATE VIEW v_license_inventory AS
        SELECT pr.id,pr.name_ar,pr.sku,pr.price_sar,
               COUNT(CASE WHEN lk.status='available' THEN 1 END) AS available_keys,
               COUNT(CASE WHEN lk.status='sold' THEN 1 END) AS sold_keys,
               COUNT(lk.id) AS total_keys
        FROM products pr
        LEFT JOIN license_keys lk ON lk.product_id=pr.id
        GROUP BY pr.id;
    `);
  } catch (e) {}

  console.log('✅ Database ready');
}
// ── Email ─────────────────────────────────────────
function getMailer() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: 587, secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false },
  });
}

const STORE = () => process.env.STORE_NAME_AR || 'SOE';
const FROM  = () => `"${STORE()}" <${process.env.EMAIL_FROM_ADDRESS || 'noreply@soe-software.com'}>`;
const WA    = () => (process.env.SUPPORT_WHATSAPP || '+966500000000').replace('+','');

async function sendLicenseEmail(order) {
  const { id, orderNumber, customerName, customerEmail, licenses = [] } = order;
  const blocks = licenses.map(l =>
    `<div style="background:#E8F8FD;border:2px dashed #1ABCEE;border-radius:12px;padding:16px;text-align:center;margin:16px 0">
      <div style="font-size:12px;color:#64748B;margin-bottom:6px">${l.productName}</div>
      <div style="font-family:monospace;font-size:18px;font-weight:800;color:#0F172A;letter-spacing:2px;word-break:break-all">${l.licenseKey}</div>
      <div style="font-size:11px;color:#94A3B8;margin-top:6px">احتفظ بهذا الكود في مكان آمن</div>
    </div>`).join('');

  const html = `<div style="font-family:system-ui,sans-serif;direction:rtl;max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#0F172A,#1a3a5c);padding:24px;text-align:center">
      <div style="color:#1ABCEE;font-size:20px;font-weight:800">${STORE()}</div>
      <div style="color:rgba(255,255,255,.5);font-size:12px">رخصتك الأصلية جاهزة!</div>
    </div>
    <div style="padding:24px">
      <div style="font-weight:700;font-size:16px;color:#1E293B;margin-bottom:8px">مرحباً ${customerName}،</div>
      <p style="font-size:13px;color:#64748B;line-height:1.7">تم تأكيد دفعك! مفتاح ترخيصك لطلب <strong>${orderNumber}</strong>:</p>
      ${blocks}
      <div style="background:#FFFBEB;border:1px solid #F59E0B;border-radius:10px;padding:12px;margin:16px 0;font-size:12px;color:#92400E">
        ⚠️ احتفظ بهذا البريد — المفتاح لا يُستبدل إلا في حالة خلل تقني موثق.
      </div>
      <div style="text-align:center;margin-top:16px">
        <a href="https://wa.me/${WA()}" style="background:#25D366;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px">💬 تواصل معنا على واتساب</a>
      </div>
    </div>
    <div style="background:#0F172A;padding:16px;text-align:center">
      <div style="color:rgba(255,255,255,.35);font-size:11px">© ${new Date().getFullYear()} ${STORE()} — رقم الطلب: ${orderNumber}</div>
    </div>
  </div>`;

  try {
    const mailer = getMailer();
    await mailer.sendMail({ from: FROM(), to: customerEmail, subject: `🔑 مفتاح رخصتك — طلب #${orderNumber}`, html });
    await q('UPDATE order_items SET license_sent=1,license_sent_at=CURRENT_TIMESTAMP WHERE order_id=?', [id]);
    await q("UPDATE orders SET status='completed' WHERE id=?", [id]);
    console.log('✅ License email sent to', customerEmail);
  } catch(err) { console.error('Email error:', err.message); }
}

async function sendOrderEmail(order) {
  const { id, orderNumber, customerName, customerEmail, items=[], totalSAR, vatSAR } = order;
  const rows = items.map(i => `<tr><td style="padding:8px 11px;border-bottom:1px solid #F0F4F8">${i.productName}</td><td style="padding:8px 11px;border-bottom:1px solid #F0F4F8;text-align:left">${parseFloat(i.totalPriceSAR||0).toFixed(2)} ر.س</td></tr>`).join('');
  const html = `<div style="font-family:system-ui,sans-serif;direction:rtl;max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#0F172A,#1a3a5c);padding:24px;text-align:center">
      <div style="color:#1ABCEE;font-size:20px;font-weight:800">${STORE()}</div>
    </div>
    <div style="padding:24px">
      <div style="font-weight:700;font-size:16px;color:#1E293B;margin-bottom:8px">مرحباً ${customerName}،</div>
      <p style="font-size:13px;color:#64748B">تم استلام طلبك رقم <strong>${orderNumber}</strong>. سيُرسل المفتاح فور تأكيد الدفع.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <thead><tr style="background:#F8FAFC"><th style="padding:9px 11px;text-align:right;font-size:12px;color:#64748B">المنتج</th><th style="padding:9px 11px;text-align:left;font-size:12px;color:#64748B">السعر</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td style="padding:8px 11px;font-size:12px;color:#64748B">ضريبة 15%</td><td style="padding:8px 11px;text-align:left;font-size:12px">${parseFloat(vatSAR||0).toFixed(2)} ر.س</td></tr>
          <tr style="background:#E8F8FD"><td style="padding:10px 11px;font-weight:800">الإجمالي</td><td style="padding:10px 11px;text-align:left;font-weight:800;color:#1ABCEE">${parseFloat(totalSAR||0).toFixed(2)} ر.س</td></tr>
        </tfoot>
      </table>
    </div>
    <div style="background:#0F172A;padding:16px;text-align:center"><div style="color:rgba(255,255,255,.35);font-size:11px">© ${new Date().getFullYear()} ${STORE()}</div></div>
  </div>`;
  try {
    const mailer = getMailer();
    await mailer.sendMail({ from: FROM(), to: customerEmail, subject: `تأكيد طلبك #${orderNumber}`, html });
  } catch(err) { console.error('Order email error:', err.message); }
}

// ── Moyasar ───────────────────────────────────────
function moyasarAuth() {
  return 'Basic ' + Buffer.from(process.env.MOYASAR_SECRET_KEY + ':').toString('base64');
}

async function createMoyasarPayment({ orderId, orderNumber, amountSAR, customerEmail, customerName }) {
  const halala = Math.round(parseFloat(amountSAR) * 100);
  const r = await axios.post('https://api.moyasar.com/v1/payments', {
    amount: halala, currency: 'SAR',
    description: `طلب ${orderNumber} — ${STORE()}`,
    publishable_api_key: process.env.MOYASAR_PUBLISHABLE_KEY,
    callback_url: `${process.env.BASE_URL || ''}/api/payments/callback`,
    source: { type: 'creditcard' },
    metadata: { order_id: orderId, order_number: orderNumber, customer_email: customerEmail },
  }, { headers: { Authorization: moyasarAuth(), 'Content-Type': 'application/json' }, timeout: 15000 });
  return { paymentId: r.data.id, paymentUrl: r.data.source.transaction_url };
}

async function getMoyasarPayment(paymentId) {
  const r = await axios.get(`https://api.moyasar.com/v1/payments/${paymentId}`,
    { headers: { Authorization: moyasarAuth() }, timeout: 10000 });
  return { status: r.data.status, amount: r.data.amount / 100, metadata: r.data.metadata, method: r.data.source?.type };
}

function verifyWebhook(rawBody, sig) {
  const secret = process.env.MOYASAR_WEBHOOK_SECRET;
  if (!secret) return true;
  const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hmac,'hex'), Buffer.from(sig,'hex')); }
  catch { return false; }
}

// ── License Fulfillment ───────────────────────────
async function fulfillOrder(orderId) {
  const items = await q(`SELECT oi.id AS item_id,oi.product_id,oi.product_name,pr.stock_mode
    FROM order_items oi JOIN products pr ON pr.id=oi.product_id
    WHERE oi.order_id=? AND oi.license_sent=FALSE`, [orderId]);
  const results = [];
  for (const item of items) {
    try {
      const local = await q1("SELECT id,key_value FROM license_keys WHERE product_id=? AND status='available' LIMIT 1", [item.product_id]);
      if (!local) throw new Error('لا مخزون لـ '+item.product_name);
      await q("UPDATE license_keys SET status='sold',order_id=?,sold_at=CURRENT_TIMESTAMP WHERE id=?", [orderId, local.id]);
      await q('UPDATE order_items SET license_key_id=? WHERE id=?', [local.id, item.item_id]);
      results.push({ productName: item.product_name, licenseKey: local.key_value, success: true });
    } catch(err) {
      results.push({ productName: item.product_name, success: false, error: err.message });
    }
  }
  return results;
}

// ── JWT ───────────────────────────────────────────
function genToken(id, role) {
  return jwt.sign({ id, role }, process.env.JWT_SECRET || 'default_secret_change_me', { expiresIn: '7d' });
}
function verifyToken(token) {
  try { return jwt.verify(token, process.env.JWT_SECRET || 'default_secret_change_me'); }
  catch { return null; }
}
function getToken(req) {
  return req.headers.authorization?.replace('Bearer ','') || req.cookies?.adminToken;
}

// ── Express Setup ─────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','PATCH'] }));
app.use(compression());
app.use(morgan('dev'));

// Webhook raw body
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
try { app.use(require('cookie-parser')()); } catch {}

const lim = rateLimit({ windowMs: 15*60*1000, max: 300 });
const payLim = rateLimit({ windowMs: 15*60*1000, max: 30 });
app.use('/api', lim);
app.use('/api/payments', payLim);

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const f = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(f)) return res.sendFile(f);
  res.redirect('/admin');
});

// ══════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════

// ── AUTH ──────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, phone, companyName } = req.body;
  if (!name||!email||!password||password.length<8) return res.status(400).json({ success:false, message:'بيانات غير صحيحة' });
  try {
    const ex = await q1('SELECT id FROM users WHERE email=?', [email.toLowerCase()]);
    if (ex) return res.status(409).json({ success:false, message:'البريد مسجل مسبقاً' });
    const hash = await bcrypt.hash(password, 12);
    const r = await q('INSERT INTO users (name,email,phone,password_hash,company_name) VALUES (?,?,?,?,?)',
      [name, email.toLowerCase(), phone||null, hash, companyName||null]);
    const token = genToken(r.insertId, 'customer');
    res.status(201).json({ success:true, data: { token, name, email } });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email||!password) return res.status(400).json({ success:false, message:'البريد وكلمة المرور مطلوبان' });
  try {
    const user = await q1('SELECT * FROM users WHERE email=? AND is_active=1', [email.toLowerCase()]);
    if (!user) return res.status(401).json({ success:false, message:'البريد أو كلمة المرور غير صحيحة' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ success:false, message:'البريد أو كلمة المرور غير صحيحة' });
    await q('UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=?', [user.id]);
    const token = genToken(user.id, user.role);
    res.json({ success:true, data: { token, user: { id:user.id, name:user.name, email:user.email, role:user.role } } });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

app.get('/api/auth/profile', async (req, res) => {
  const u = verifyToken(getToken(req));
  if (!u) return res.status(401).json({ success:false });
  const user = await q1('SELECT id,name,email,phone,role,company_name,created_at FROM users WHERE id=?', [u.id]);
  res.json({ success:true, data:user });
});

// ── PRODUCTS ──────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const { category, search, sort, featured, limit=100, page=1 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    let sql = 'SELECT p.*,c.slug AS category_slug,c.name_ar AS category_name FROM products p JOIN categories c ON c.id=p.category_id WHERE p.is_active=1';
    const params = [];
    if (category && category!=='all') { sql+=' AND c.slug=?'; params.push(category); }
    if (featured==='true') { sql+=' AND p.is_featured=1'; }
    if (search) { sql+=' AND (p.name_ar LIKE ? OR p.vendor LIKE ? OR p.description_ar LIKE ?)'; const s=`%${search}%`; params.push(s,s,s); }
    const sortMap = { price_asc:'p.price_sar ASC', price_desc:'p.price_sar DESC', rating:'p.rating DESC', featured:'p.is_featured DESC,p.sort_order ASC' };
    sql += ` ORDER BY ${sortMap[sort]||sortMap.featured} LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);
    const products = await q(sql, params);
    res.json({ success:true, data:products });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

app.get('/api/products/categories', async (req, res) => {
  const cats = await q('SELECT * FROM categories WHERE is_active=1 ORDER BY sort_order');
  res.json({ success:true, data:cats });
});

app.get('/api/products/:id', async (req, res) => {
  const p = await q1('SELECT p.*,c.slug AS category_slug FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.is_active=1', [req.params.id]);
  if (!p) return res.status(404).json({ success:false, message:'غير موجود' });
  const [stk] = await q("SELECT COUNT(*) AS n FROM license_keys WHERE product_id=? AND status='available'", [p.id]);
  p.in_stock = stk.n > 0; p.stock_count = stk.n;
  p.features = JSON.parse(p.features||'[]');
  res.json({ success:true, data:p });
});

// ── PAYMENTS ──────────────────────────────────────
app.post('/api/payments/initiate', async (req, res) => {
  const { items, customerName, customerEmail, customerPhone, country='SA', couponCode } = req.body;
  if (!items?.length||!customerEmail||!customerName) return res.status(400).json({ success:false, message:'بيانات ناقصة' });
  try {
    const ids = items.map(i=>i.productId);
    const pl = ids.map(()=>'?').join(',');
    const prods = await q(`SELECT * FROM products WHERE id IN (${pl}) AND is_active=1`, ids);
    if (prods.length!==ids.length) return res.status(400).json({ success:false, message:'أحد المنتجات غير متاح' });
    let subtotal = 0;
    const orderItems = items.map(item => {
      const p = prods.find(x=>x.id===item.productId);
      const total = parseFloat(p.price_sar) * (item.quantity||1);
      subtotal += total;
      return { product:p, quantity:item.quantity||1, lineTotal:total };
    });
    let discountSAR = 0, couponRec = null;
    if (couponCode) {
      couponRec = await q1("SELECT * FROM coupons WHERE code=? AND is_active=1 AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP) AND used_count<max_uses AND min_order_sar<=?",[couponCode.toUpperCase(),subtotal]);
      if (couponRec) discountSAR = couponRec.discount_type==='percent' ? subtotal*couponRec.discount_value/100 : parseFloat(couponRec.discount_value);
    }
    const vatAmt = (subtotal-discountSAR)*0.15;
    const total  = subtotal-discountSAR+vatAmt;
    const u = verifyToken(getToken(req));

    // Create order
    const on = 'SOE-'+new Date().getFullYear()+'-'+String(Math.floor(Math.random()*90000)+10000);
    const pool = await getDB(); const conn = await pool.getConnection();
    await conn.beginTransaction();
    let orderId;
    try {
      const [or] = await conn.execute(
        "INSERT INTO orders (order_number,user_id,customer_name,customer_email,customer_phone,customer_country,subtotal_sar,discount_sar,vat_rate,vat_amount_sar,total_sar,coupon_code,coupon_discount,status,ip_address) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)",
        [on, u?.id||null, customerName, customerEmail, customerPhone||null, country, subtotal.toFixed(2), discountSAR.toFixed(2), 15, vatAmt.toFixed(2), total.toFixed(2), couponCode||null, discountSAR.toFixed(2), req.ip]);
      orderId = or.insertId;
      for (const item of orderItems) {
        await conn.execute('INSERT INTO order_items (order_id,product_id,product_name,product_sku,quantity,unit_price_sar,total_price_sar) VALUES (?,?,?,?,?,?,?)',
          [orderId, item.product.id, item.product.name_ar, item.product.sku, item.quantity, parseFloat(item.product.price_sar).toFixed(2), item.lineTotal.toFixed(2)]);
      }
      if (couponRec) await conn.execute('UPDATE coupons SET used_count=used_count+1 WHERE id=?', [couponRec.id]);
      await conn.commit();
    } catch(e) { await conn.rollback(); conn.release(); throw e; }
    conn.release();

    // Try Moyasar
    let paymentUrl, paymentId;
    try {
      const pay = await createMoyasarPayment({ orderId, orderNumber:on, amountSAR:total.toFixed(2), customerEmail, customerName });
      paymentUrl = pay.paymentUrl; paymentId = pay.paymentId;
      await q("INSERT INTO payments (order_id,provider,provider_payment_id,amount_sar,status) VALUES (?,'moyasar',?,'initiated')", [orderId, paymentId, total.toFixed(2)]);
    } catch(e) {
      console.error('Moyasar error:', e.message);
      paymentUrl = null; paymentId = null;
    }

    sendOrderEmail({ id:orderId, orderNumber:on, customerName, customerEmail,
      items: orderItems.map(i=>({ productName:i.product.name_ar, totalPriceSAR:i.lineTotal })),
      totalSAR:total.toFixed(2), vatSAR:vatAmt.toFixed(2) }).catch(()=>{});

    res.json({ success:true, data: { orderId, orderNumber:on, totalSAR:total.toFixed(2), paymentUrl, paymentId } });
  } catch(err) { console.error(err); res.status(500).json({ success:false, message:'فشل إنشاء الطلب' }); }
});

app.get('/api/payments/callback', async (req, res) => {
  const { id:paymentId } = req.query;
  if (!paymentId) return res.redirect('/?payment=failed');
  try {
    const pd = await getMoyasarPayment(paymentId);
    if (pd.status==='paid') {
      await processPayment(paymentId, pd);
      return res.redirect('/?payment=success&order='+pd.metadata?.order_number);
    }
    return res.redirect('/?payment=failed');
  } catch { return res.redirect('/?payment=failed'); }
});

app.post('/api/payments/webhook', async (req, res) => {
  const sig = req.headers['moyasar-signature'] || '';
  if (!verifyWebhook(req.body, sig)) return res.status(401).json({ success:false });
  let event;
  try { event = JSON.parse(req.body.toString()); } catch { return res.status(400).json({ success:false }); }
  res.json({ success:true });
  if (event.type==='payment_paid') {
    await processPayment(event.data.id, event.data).catch(e => console.error('Webhook err:', e.message));
  }
});

async function processPayment(paymentId, payData) {
  const ex = await q1("SELECT status FROM payments WHERE provider_payment_id=?", [paymentId]);
  if (ex?.status==='paid') return;
  const orderId = parseInt(payData.metadata?.order_id || (await q1("SELECT order_id FROM payments WHERE provider_payment_id=?", [paymentId]))?.order_id);
  if (!orderId) return;
  await q("UPDATE payments SET status='paid',payment_method=? WHERE provider_payment_id=?", [payData.source?.type||payData.method||'card', paymentId]);
  await q("UPDATE orders SET status='processing' WHERE id=?", [orderId]);
  const licenses = await fulfillOrder(orderId);
  const ok = licenses.filter(l=>l.success);
  if (ok.length) {
    const order = await q1('SELECT * FROM orders WHERE id=?', [orderId]);
    await sendLicenseEmail({ id:orderId, orderNumber:order.order_number, customerName:order.customer_name, customerEmail:order.customer_email, licenses:ok });
  }
}

app.post('/api/payments/validate-coupon', async (req, res) => {
  const { code, orderTotal=0 } = req.body;
  if (!code) return res.status(400).json({ success:false, message:'الكود مطلوب' });
  const coupon = await q1("SELECT * FROM coupons WHERE code=? AND is_active=1 AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP) AND used_count<max_uses AND min_order_sar<=?", [code.toUpperCase(), parseFloat(orderTotal)]);
  if (!coupon) return res.status(404).json({ success:false, message:'الكود غير صحيح أو منتهي' });
  const disc = coupon.discount_type==='percent' ? parseFloat(orderTotal)*coupon.discount_value/100 : parseFloat(coupon.discount_value);
  res.json({ success:true, data:{ code:coupon.code, type:coupon.discount_type, value:coupon.discount_value, discount_sar:disc.toFixed(2) } });
});

app.get('/api/payments/moyasar-key', (req, res) => {
  res.json({ success:true, publishableKey:process.env.MOYASAR_PUBLISHABLE_KEY, liveMode:process.env.MOYASAR_LIVE_MODE==='true' });
});

// ── ORDERS ────────────────────────────────────────
app.get('/api/orders/my', async (req, res) => {
  const u = verifyToken(getToken(req));
  if (!u) return res.status(401).json({ success:false });
  const orders = await q("SELECT o.*,p.status AS payment_status FROM orders o LEFT JOIN payments p ON p.order_id=o.id WHERE o.user_id=? ORDER BY o.created_at DESC", [u.id]);
  res.json({ success:true, data:orders });
});

app.get('/api/orders/track/:num', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ success:false, message:'البريد مطلوب' });
  const order = await q1('SELECT order_number,customer_name,status,total_sar,created_at FROM orders WHERE order_number=? AND customer_email=?', [req.params.num, email.toLowerCase()]);
  if (!order) return res.status(404).json({ success:false, message:'الطلب غير موجود' });
  res.json({ success:true, data:order });
});

app.get('/api/orders/:num', async (req, res) => {
  const u = verifyToken(getToken(req));
  const order = await q1('SELECT * FROM orders WHERE order_number=?', [req.params.num]);
  if (!order) return res.status(404).json({ success:false });
  if (u?.role!=='admin' && order.user_id && order.user_id!==u?.id) return res.status(403).json({ success:false });
  const items = await q("SELECT oi.*,CASE WHEN o.status IN ('completed','processing') AND oi.license_sent=1 THEN lk.key_value ELSE NULL END AS license_key FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN license_keys lk ON lk.id=oi.license_key_id WHERE oi.order_id=?", [order.id]);
  const payment = await q1('SELECT provider,payment_method,status,amount_sar FROM payments WHERE order_id=?', [order.id]);
  res.json({ success:true, data:{ ...order, items, payment } });
});

// ── SETTINGS ──────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  const rows = await q('SELECT * FROM settings');
  const map = {}; rows.forEach(s=>{map[s.key_name]=s.value;});
  res.json({ success:true, data:map });
});

app.post('/api/settings', async (req, res) => {
  const u = verifyToken(getToken(req));
  if (u?.role!=='admin') return res.status(403).json({ success:false });
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ success:false });
  await q('INSERT INTO settings (key_name,value) VALUES (?,?) ON CONFLICT(key_name) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP', [key,value]);
  res.json({ success:true });
});

// ── ADMIN API ─────────────────────────────────────
function adminOnly(req, res, next) {
  const u = verifyToken(getToken(req));
  if (!u || u.role!=='admin') return res.status(403).json({ success:false, message:'للمدير فقط' });
  req.user = u; next();
}

app.get('/api/admin/stats', adminOnly, async (req, res) => {
  const [rev] = await q("SELECT COALESCE(SUM(total_sar),0) AS r,COUNT(*) AS c FROM orders WHERE status IN ('completed','processing','paid') AND strftime('%m', created_at)=strftime('%m','now')");
  const [keys] = await q("SELECT COUNT(*) AS k FROM license_keys WHERE status='available'");
  const [custs] = await q("SELECT COUNT(*) AS c FROM users WHERE role='customer'");
  res.json({ success:true, data:{ revenue:parseFloat(rev.r||0), orders:rev.c||0, available_keys:keys.k||0, customers:custs.c||0 } });
});

app.get('/api/admin/orders', adminOnly, async (req, res) => {
  const { limit=20, page=1, status, search } = req.query;
  let sql="SELECT o.id,o.order_number,o.customer_name,o.customer_email,o.total_sar,o.status,o.created_at,p.status AS payment_status FROM orders o LEFT JOIN payments p ON p.order_id=o.id WHERE 1=1";
  const params=[];
  if(status){sql+=' AND o.status=?';params.push(status);}
  if(search){sql+=' AND (o.customer_email LIKE ? OR o.order_number LIKE ?)';params.push(`%${search}%`,`%${search}%`);}
  sql+=' ORDER BY o.created_at DESC LIMIT ? OFFSET ?'; params.push(parseInt(limit),(parseInt(page)-1)*parseInt(limit));
  const orders = await q(sql,params);
  res.json({ success:true, data:orders });
});

app.get('/api/admin/orders/:id', adminOnly, async (req, res) => {
  const order = await q1('SELECT * FROM orders WHERE id=?', [req.params.id]);
  if (!order) return res.status(404).json({ success:false });
  const items = await q('SELECT oi.*,lk.key_value AS license_key FROM order_items oi LEFT JOIN license_keys lk ON lk.id=oi.license_key_id WHERE oi.order_id=?', [order.id]);
  const payment = await q1('SELECT * FROM payments WHERE order_id=?', [order.id]);
  res.json({ success:true, data:{ ...order, items, payment } });
});

app.post('/api/admin/orders/:id/resend', adminOnly, async (req, res) => {
  try {
    const order = await q1('SELECT * FROM orders WHERE id=?', [req.params.id]);
    if (!order) return res.status(404).json({ success:false });
    const items = await q("SELECT oi.product_name,lk.key_value AS license_key FROM order_items oi JOIN license_keys lk ON lk.id=oi.license_key_id WHERE oi.order_id=? AND lk.status='sold'", [order.id]);
    if (!items.length) return res.status(400).json({ success:false, message:'لا توجد رخص' });
    await sendLicenseEmail({ id:order.id, orderNumber:order.order_number, customerName:order.customer_name, customerEmail:order.customer_email, licenses:items.map(i=>({productName:i.product_name,licenseKey:i.license_key})) });
    res.json({ success:true, message:'تم إعادة الإرسال' });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

app.get('/api/admin/inventory', adminOnly, async (req, res) => {
  try {
    const items = await q(`SELECT pr.id,pr.name_ar,pr.sku,pr.price_sar,
      COUNT(CASE WHEN lk.status='available' THEN 1 END) AS available_keys,
      COUNT(CASE WHEN lk.status='sold' THEN 1 END) AS sold_keys,
      COUNT(lk.id) AS total_keys
      FROM products pr LEFT JOIN license_keys lk ON lk.product_id=pr.id
      WHERE pr.is_active=TRUE GROUP BY pr.id ORDER BY available_keys ASC`);
    res.json({ success:true, data:items });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

app.post('/api/admin/licenses/import', adminOnly, async (req, res) => {
  const { productId, keys } = req.body;
  if (!productId||!keys?.length) return res.status(400).json({ success:false });
  let added=0, failed=0;
  const batch=`manual-${Date.now()}`;
  for (const k of keys) {
    const clean=k.trim(); if(!clean) continue;
    try { await q("INSERT INTO license_keys (product_id,key_value,status,source,batch_id) VALUES (?,?,'available','manual',?)",[productId,clean,batch]); added++; }
    catch { failed++; }
  }
  res.json({ success:true, data:{ added, failed }, message:`تم إضافة ${added} كود` });
});

app.get('/api/admin/products', adminOnly, async (req, res) => {
  const prods = await q('SELECT p.*,c.name_ar AS cat FROM products p JOIN categories c ON c.id=p.category_id ORDER BY p.sort_order,p.id');
  res.json({ success:true, data:prods });
});

app.post('/api/admin/products', adminOnly, async (req, res) => {
  const {sku,category_id,vendor,name_ar,name_en,description_ar,price_sar,original_price_sar,badge,badge_label_ar,features,redington_sku,stock_mode,is_featured} = req.body;
  if (!sku||!name_ar||!price_sar||!category_id) return res.status(400).json({ success:false, message:'حقول ناقصة' });
  try {
    const r = await q('INSERT INTO products (sku,category_id,vendor,name_ar,name_en,description_ar,price_sar,original_price_sar,badge,badge_label_ar,features,redington_sku,stock_mode,is_featured) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [sku,category_id,vendor||'',name_ar,name_en||name_ar,description_ar||'',price_sar,original_price_sar||null,badge||'new',badge_label_ar||'',JSON.stringify(features||[]),redington_sku||null,stock_mode||'manual',is_featured?1:0]);
    res.status(201).json({ success:true, data:{ id:r.insertId } });
  } catch(e) {
    if(e.code==='ER_DUP_ENTRY') return res.status(409).json({ success:false, message:'SKU مستخدم' });
    res.status(500).json({ success:false, message:e.message });
  }
});

app.put('/api/admin/products/:id', adminOnly, async (req, res) => {
  const f=['name_ar','price_sar','original_price_sar','badge','badge_label_ar','is_active','is_featured'];
  const upd=[]; const params=[];
  f.forEach(k=>{if(req.body[k]!==undefined){upd.push(`${k}=?`);params.push(req.body[k]);}});
  if(!upd.length) return res.status(400).json({ success:false });
  upd.push('updated_at=CURRENT_TIMESTAMP'); params.push(req.params.id);
  await q(`UPDATE products SET ${upd.join(',')} WHERE id=?`, params);
  res.json({ success:true });
});

app.get('/api/admin/customers', adminOnly, async (req, res) => {
  const custs = await q("SELECT u.*,COUNT(o.id) AS order_count,COALESCE(SUM(o.total_sar),0) AS total_spent FROM users u LEFT JOIN orders o ON o.user_id=u.id AND o.status IN ('completed','processing') WHERE u.role='customer' GROUP BY u.id ORDER BY u.created_at DESC LIMIT 100");
  res.json({ success:true, data:custs });
});

app.get('/api/admin/top-products', adminOnly, async (req, res) => {
  const data = await q("SELECT p.name_ar,COUNT(oi.id) AS sold_count FROM order_items oi JOIN products p ON p.id=oi.product_id JOIN orders o ON o.id=oi.order_id WHERE o.status IN ('completed','processing') GROUP BY p.id ORDER BY sold_count DESC LIMIT 5");
  res.json({ success:true, data });
});

app.get('/api/admin/reports/daily', adminOnly, async (req, res) => {
  const { from, to } = req.query;
  const df=from||new Date(Date.now()-30*86400000).toISOString().split('T')[0];
  const dt=to||new Date().toISOString().split('T')[0];
  const data = await q("SELECT DATE(created_at) AS date,COUNT(*) AS orders,SUM(total_sar) AS revenue,SUM(vat_amount_sar) AS vat FROM orders WHERE status IN ('completed','processing','paid') AND created_at BETWEEN ? AND ? GROUP BY DATE(created_at) ORDER BY date ASC",[df,dt+' 23:59:59']);
  res.json({ success:true, data });
});

// ══════════════════════════════════════════════════
// ADMIN PANEL (SSR Pages)
// ══════════════════════════════════════════════════
function adminCheck(req, res, next) {
  const token = req.cookies?.adminToken;
  if (!token) return res.redirect('/admin/login');
  const u = verifyToken(token);
  if (!u || u.role!=='admin') return res.redirect('/admin/login');
  req.admin = u; next();
}

function layout(title, body) {
  const nav = [
    ['/admin','📊','الإحصائيات'],
    ['/admin/orders','📦','الطلبات'],
    ['/admin/products','🛍','المنتجات'],
    ['/admin/licenses','🔑','الرخص'],
    ['/admin/customers','👥','العملاء'],
    ['/admin/reports','📈','التقارير'],
    ['/admin/settings','⚙️','الإعدادات'],
  ].map(([h,i,l])=>`<a href="${h}" class="na">${i} ${l}</a>`).join('');
  return `<!DOCTYPE html><html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — SOE Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#F0F4F8;display:flex;min-height:100vh}
.sb{width:195px;background:#0F172A;position:fixed;height:100vh;display:flex;flex-direction:column;z-index:10}
.sb-top{padding:14px;border-bottom:1px solid rgba(255,255,255,.1)}
.sb-top h1{color:#1ABCEE;font-size:14px;letter-spacing:2px}
.sb-top p{color:rgba(255,255,255,.3);font-size:10px}
.na{display:flex;align-items:center;gap:7px;padding:9px 13px;color:rgba(255,255,255,.5);text-decoration:none;font-size:12px;border-right:3px solid transparent}
.na:hover{color:#fff;background:rgba(26,188,238,.1);border-right-color:#1ABCEE}
.mn{margin-right:195px;flex:1;min-width:0}
.tb{background:#fff;border-bottom:1px solid #DDE6EF;padding:0 18px;height:52px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:5}
.tb h2{font-size:14px;font-weight:700}
.cnt{padding:16px;min-height:calc(100vh - 52px)}
.card{background:#fff;border:1.5px solid #DDE6EF;border-radius:12px;overflow:hidden;margin-bottom:12px}
.ch{padding:11px 14px;border-bottom:1px solid #DDE6EF;display:flex;align-items:center;justify-content:space-between}
.ct{font-size:13px;font-weight:700}
.sg{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:12px}
.sc{background:#fff;border:1.5px solid #DDE6EF;border-radius:12px;padding:14px}
.sl{font-size:10px;color:#64748B;font-weight:600;text-transform:uppercase;letter-spacing:.7px;margin-bottom:5px}
.sv{font-size:24px;font-weight:800;color:#1E293B}
.ss{font-size:10px;color:#94A3B8;margin-top:2px}
table{width:100%;border-collapse:collapse}
th{background:#F8FAFC;padding:8px 10px;font-size:10px;color:#64748B;text-align:right;border-bottom:1px solid #DDE6EF;white-space:nowrap}
td{padding:9px 10px;font-size:11px;border-bottom:1px solid #F0F4F8;vertical-align:middle}
tr:last-child td{border-bottom:none}tr:hover td{background:#F8FAFC}
.btn{display:inline-block;background:#1ABCEE;color:#fff;border:none;border-radius:7px;padding:5px 11px;font-size:11px;font-weight:700;cursor:pointer;text-decoration:none;font-family:inherit}
.btn-o{background:transparent;border:1.5px solid #DDE6EF;color:#1E293B}
.bdg{border-radius:5px;padding:2px 8px;font-size:10px;font-weight:700}
.bp{background:#FFFBEB;color:#D97706}.bc{background:#EFF6FF;color:#3B82F6}
.bg{background:#DCFCE7;color:#16A34A}.br{background:#FEF2F2;color:#DC2626}
.bv{background:#F5F3FF;color:#7C3AED}
.fi{background:#F8FAFC;border:1.5px solid #DDE6EF;border-radius:8px;padding:8px 10px;font-size:12px;font-family:inherit;outline:none}
.fi:focus{border-color:#1ABCEE}
.fg{margin-bottom:10px}
.fg label{display:block;font-size:11px;font-weight:700;color:#1E293B;margin-bottom:3px}
@media(max-width:640px){.sb{display:none}.mn{margin-right:0}}
</style></head>
<body>
<aside class="sb">
  <div class="sb-top"><h1>SOE Admin</h1><p>لوحة التحكم</p></div>
  <nav style="padding:8px 0;flex:1">${nav}</nav>
  <a href="/admin/logout" style="display:block;padding:11px 13px;color:rgba(239,68,68,.7);font-size:11px;text-decoration:none;border-top:1px solid rgba(255,255,255,.06)">🚪 تسجيل الخروج</a>
</aside>
<main class="mn">
  <header class="tb"><h2>${title}</h2><span style="font-size:11px;color:#94A3B8">مرحباً، المدير</span></header>
  <div class="cnt">${body}</div>
</main>
</body></html>`;
}

function sBadge(s){
  const m={pending:'bp',paid:'bc',processing:'bv',completed:'bg',failed:'br',cancelled:'bp',refunded:'bc'};
  const l={pending:'انتظار',paid:'مدفوع',processing:'معالجة',completed:'مكتمل',failed:'فشل',cancelled:'ملغي',refunded:'مسترد'};
  return `<span class="bdg ${m[s]||'bp'}">${l[s]||s}</span>`;
}

app.get('/admin/login', (req, res) => res.send(`<!DOCTYPE html><html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>دخول</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:linear-gradient(135deg,#0F172A,#1a3a5c);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.box{background:#fff;border-radius:16px;padding:32px;width:100%;max-width:360px}
h1{font-size:18px;color:#0F172A;text-align:center;margin-bottom:4px}p{font-size:12px;color:#94A3B8;text-align:center;margin-bottom:22px}
label{display:block;font-size:11px;font-weight:700;color:#1E293B;margin-bottom:4px}
input{width:100%;background:#F8FAFC;border:1.5px solid #DDE6EF;border-radius:9px;padding:11px;font-size:14px;outline:none;margin-bottom:12px;font-family:inherit}
input:focus{border-color:#1ABCEE}button{width:100%;background:#1ABCEE;color:#fff;border:none;border-radius:9px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}
.err{background:#FEF2F2;color:#DC2626;border-radius:8px;padding:9px;font-size:12px;margin-bottom:10px;display:none}</style></head>
<body><div class="box">
<div style="text-align:center;font-size:30px;margin-bottom:12px">🔐</div>
<h1>SOE Admin Panel</h1><p>للمسؤولين فقط</p>
<div class="err" id="err"></div>
<label>البريد الإلكتروني</label><input type="email" id="em" placeholder="admin@soe.com" autocomplete="email">
<label>كلمة المرور</label><input type="password" id="pw" placeholder="••••••••" autocomplete="current-password">
<button onclick="go()">تسجيل الدخول</button>
</div>
<script>
async function go(){
  const em=document.getElementById('em').value,pw=document.getElementById('pw').value;
  const err=document.getElementById('err'); err.style.display='none';
  const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:em,password:pw})});
  const d=await r.json();
  if(d.success&&d.data.user.role==='admin'){
    document.cookie='adminToken='+d.data.token+';path=/admin;max-age=604800';
    localStorage.setItem('adminToken',d.data.token);location.href='/admin';
  }else{err.textContent=d.message||'بيانات غير صحيحة';err.style.display='block';}
}
document.addEventListener('keydown',e=>{if(e.key==='Enter')go();});
</script></body></html>`));

app.get('/admin/logout',(req,res)=>{res.clearCookie('adminToken',{path:'/admin'});res.redirect('/admin/login');});

app.get(['/admin','/admin/'], adminCheck, async (req, res) => {
  const [rev]=await q("SELECT COALESCE(SUM(total_sar),0) AS r,COUNT(*) AS c FROM orders WHERE status IN ('completed','processing','paid') AND strftime('%m', created_at)=strftime('%m','now')");
  const [keys]=await q("SELECT COUNT(*) AS k FROM license_keys WHERE status='available'");
  const [custs]=await q("SELECT COUNT(*) AS c FROM users WHERE role='customer'");
  const orders=await q("SELECT o.id,o.order_number,o.customer_name,o.customer_email,o.total_sar,o.status,o.created_at FROM orders o ORDER BY o.created_at DESC LIMIT 8");
  const inv=await q(`SELECT pr.name_ar,pr.sku,COUNT(CASE WHEN lk.status='available' THEN 1 END) AS av,COUNT(CASE WHEN lk.status='sold' THEN 1 END) AS sold FROM products pr LEFT JOIN license_keys lk ON lk.product_id=pr.id GROUP BY pr.id ORDER BY av ASC LIMIT 8`);
  const orows=orders.map(o=>`<tr><td style="font-family:monospace;font-weight:700">${o.order_number}</td><td><div style="font-weight:600">${o.customer_name}</div><div style="font-size:10px;color:#94A3B8">${o.customer_email}</div></td><td style="font-weight:700">${parseFloat(o.total_sar||0).toLocaleString('ar-SA')} ر.س</td><td>${sBadge(o.status)}</td><td style="font-size:10px;color:#94A3B8">${new Date(o.created_at).toLocaleDateString('ar-SA')}</td><td><a href="/admin/orders/${o.id}" class="btn">عرض</a></td></tr>`).join('');
  const irows=inv.map(i=>{const low=i.av<5;return`<tr style="${low?'background:#FFFBEB':''}"><td style="font-weight:600">${i.name_ar}${low?'<br><span style="color:#DC2626;font-size:10px">⚠️ منخفض</span>':''}</td><td style="font-weight:800;color:${low?'#DC2626':'#16A34A'}">${i.av}</td><td>${i.sold}</td><td><a href="/admin/licenses" class="btn">إضافة</a></td></tr>`;}).join('');
  res.send(layout('الإحصائيات',`
    <div class="sg">
      <div class="sc"><div class="sl">إيرادات الشهر</div><div class="sv">${parseFloat(rev.r||0).toLocaleString('ar-SA')}</div><div class="ss">ريال سعودي</div></div>
      <div class="sc"><div class="sl">طلبات الشهر</div><div class="sv">${rev.c||0}</div><div class="ss">طلب</div></div>
      <div class="sc"><div class="sl">رخص متاحة</div><div class="sv">${keys.k||0}</div><div class="ss">في المخزون</div></div>
      <div class="sc"><div class="sl">العملاء</div><div class="sv">${custs.c||0}</div><div class="ss">مسجل</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="card"><div class="ch"><div class="ct">📦 آخر الطلبات</div><a href="/admin/orders" class="btn btn-o">الكل</a></div><div style="overflow-x:auto"><table><thead><tr><th>رقم الطلب</th><th>العميل</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th><th></th></tr></thead><tbody>${orows||'<tr><td colspan="6" style="text-align:center;padding:20px;color:#94A3B8">لا يوجد</td></tr>'}</tbody></table></div></div>
      <div class="card"><div class="ch"><div class="ct">🔑 الرخص</div><a href="/admin/licenses" class="btn btn-o">إدارة</a></div><div style="overflow-x:auto"><table><thead><tr><th>المنتج</th><th>متاح</th><th>مُباع</th><th></th></tr></thead><tbody>${irows||'<tr><td colspan="4" style="text-align:center;padding:20px;color:#94A3B8">لا يوجد</td></tr>'}</tbody></table></div></div>
    </div>`));
});

app.get('/admin/orders', adminCheck, async (req, res) => {
  const {status,search,page=1}=req.query;
  let sql="SELECT o.id,o.order_number,o.customer_name,o.customer_email,o.total_sar,o.status,o.created_at FROM orders o WHERE 1=1";
  const params=[];
  if(status){sql+=' AND o.status=?';params.push(status);}
  if(search){sql+=' AND (o.customer_email LIKE ? OR o.order_number LIKE ?)';params.push(`%${search}%`,`%${search}%`);}
  sql+=' ORDER BY o.created_at DESC LIMIT 30 OFFSET ?';params.push((parseInt(page)-1)*30);
  const orders=await q(sql,params);
  const stabs=['pending','paid','processing','completed','failed','cancelled'].map(s=>`<a href="?status=${s}" style="padding:4px 10px;border-radius:100px;background:${status===s?'#1ABCEE':'#F0F4F8'};color:${status===s?'#fff':'#64748B'};text-decoration:none;font-size:11px;font-weight:600">${s}</a>`).join('');
  const rows=orders.map(o=>`<tr><td style="font-family:monospace;font-weight:700">${o.order_number}</td><td><div style="font-weight:600">${o.customer_name}</div><div style="font-size:10px;color:#94A3B8">${o.customer_email}</div></td><td style="font-weight:700">${parseFloat(o.total_sar||0).toLocaleString('ar-SA')} ر.س</td><td>${sBadge(o.status)}</td><td style="font-size:10px;color:#94A3B8">${new Date(o.created_at).toLocaleDateString('ar-SA')}</td><td><a href="/admin/orders/${o.id}" class="btn">عرض</a></td></tr>`).join('');
  res.send(layout('الطلبات',`<div style="display:flex;gap:7px;margin-bottom:10px;flex-wrap:wrap"><input class="fi" placeholder="بحث..." value="${search||''}" onchange="location.href='?search='+this.value" style="max-width:200px">${stabs}</div><div class="card" style="overflow-x:auto"><table><thead><tr><th>رقم الطلب</th><th>العميل</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="6" style="text-align:center;padding:30px;color:#94A3B8">لا توجد طلبات</td></tr>'}</tbody></table></div>`));
});

app.get('/admin/orders/:id', adminCheck, async (req, res) => {
  const order=await q1('SELECT * FROM orders WHERE id=?',[req.params.id]);
  if(!order) return res.status(404).send('غير موجود');
  const items=await q('SELECT oi.*,lk.key_value AS lk FROM order_items oi LEFT JOIN license_keys lk ON lk.id=oi.license_key_id WHERE oi.order_id=?',[order.id]);
  const pay=await q1('SELECT * FROM payments WHERE order_id=?',[order.id]);
  const irows=items.map(i=>`<tr><td style="font-weight:600">${i.product_name}</td><td>${parseFloat(i.total_price_sar).toLocaleString('ar-SA')} ر.س</td><td style="font-family:monospace;font-size:11px;color:#1ABCEE">${i.lk||'—'}</td><td>${i.license_sent?'✅ أُرسل':'⏳ لم يُرسل'}</td></tr>`).join('');
  res.send(layout(`طلب #${order.order_number}`,`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:11px">
      <div class="card"><div class="ch"><div class="ct">📋 الطلب</div></div><div style="padding:13px;font-size:12px;display:flex;flex-direction:column;gap:7px">
        <div style="display:flex;justify-content:space-between"><span style="color:#64748B">الحالة</span><span>${sBadge(order.status)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#64748B">الإجمالي</span><span style="font-weight:700">${parseFloat(order.total_sar).toLocaleString('ar-SA')} ر.س</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#64748B">الضريبة</span><span>${parseFloat(order.vat_amount_sar||0).toFixed(2)} ر.س</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#64748B">التاريخ</span><span style="font-size:11px">${new Date(order.created_at).toLocaleString('ar-SA')}</span></div>
      </div></div>
      <div class="card"><div class="ch"><div class="ct">👤 العميل</div></div><div style="padding:13px;font-size:12px;display:flex;flex-direction:column;gap:7px">
        <div style="display:flex;justify-content:space-between"><span style="color:#64748B">الاسم</span><span style="font-weight:600">${order.customer_name}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#64748B">البريد</span><span style="word-break:break-all">${order.customer_email}</span></div>
      </div></div>
    </div>
    <div class="card"><div class="ch"><div class="ct">📦 الرخص</div><button class="btn" onclick="resend(${order.id})">📧 إعادة إرسال</button></div>
      <table><thead><tr><th>المنتج</th><th>السعر</th><th>الكود</th><th>أُرسل</th></tr></thead>
      <tbody>${irows}</tbody></table></div>
    ${pay?`<div class="card"><div class="ch"><div class="ct">💳 الدفع</div></div><div style="padding:13px;font-size:12px;display:flex;flex-direction:column;gap:7px">
      <div style="display:flex;justify-content:space-between"><span style="color:#64748B">الحالة</span>${sBadge(pay.status)}</div>
      <div style="display:flex;justify-content:space-between"><span style="color:#64748B">الطريقة</span><span>${pay.payment_method||'-'}</span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:#64748B">المبلغ</span><span style="font-weight:700">${parseFloat(pay.amount_sar||0).toLocaleString('ar-SA')} ر.س</span></div>
    </div></div>`:''}
    <script>async function resend(id){if(!confirm('إعادة إرسال الرخصة؟'))return;const r=await fetch('/api/admin/orders/'+id+'/resend',{method:'POST',headers:{Authorization:'Bearer '+localStorage.getItem('adminToken')}});const d=await r.json();alert(d.message);}</script>`));
});

app.get('/admin/products', adminCheck, async (req, res) => {
  const prods=await q('SELECT p.*,c.name_ar AS cat FROM products p JOIN categories c ON c.id=p.category_id ORDER BY p.sort_order,p.id');
  const rows=prods.map(p=>`<tr><td><div style="font-weight:600">${p.icon||'📦'} ${p.name_ar}</div><div style="font-size:10px;color:#94A3B8">${p.sku}</div></td><td style="font-size:11px">${p.cat}</td><td style="font-size:11px">${p.vendor||'-'}</td><td style="font-weight:700">${parseFloat(p.price_sar).toLocaleString('ar-SA')} ر.س</td><td>${p.is_active?'✅':'⛔'}</td><td>${p.is_featured?'⭐':'-'}</td></tr>`).join('');
  res.send(layout('المنتجات',`<div class="card" style="overflow-x:auto"><table><thead><tr><th>المنتج</th><th>الفئة</th><th>الموزع</th><th>السعر</th><th>نشط</th><th>مميز</th></tr></thead><tbody>${rows}</tbody></table></div>`));
});

app.get('/admin/licenses', adminCheck, async (req, res) => {
  const inv=await q(`SELECT pr.id,pr.name_ar,pr.sku,COUNT(CASE WHEN lk.status='available' THEN 1 END) AS av,COUNT(CASE WHEN lk.status='sold' THEN 1 END) AS sold,COUNT(lk.id) AS total FROM products pr LEFT JOIN license_keys lk ON lk.product_id=pr.id WHERE pr.is_active=TRUE GROUP BY pr.id ORDER BY av ASC`);
  const opts=inv.map(i=>`<option value="${i.id}">${i.name_ar} (${i.sku})</option>`).join('');
  const rows=inv.map(i=>{const low=i.av<5;return`<tr style="${low?'background:#FFFBEB':''}"><td style="font-weight:600">${i.name_ar}${low?'<br><span style="color:#DC2626;font-size:10px">⚠️ منخفض</span>':''}</td><td style="font-family:monospace;font-size:10px">${i.sku}</td><td style="font-weight:800;color:${low?'#DC2626':'#16A34A'}">${i.av}</td><td>${i.sold}</td><td>${i.total}</td></tr>`;}).join('');
  res.send(layout('مخزون الرخص',`
    <div class="card" style="margin-bottom:12px"><div class="ch"><div class="ct">➕ استيراد رخص يدوي</div></div>
    <div style="padding:13px">
      <div class="fg"><label>المنتج</label><select class="fi" id="pid" style="width:100%"><option value="">اختر...</option>${opts}</select></div>
      <div class="fg"><label>الأكواد (كل كود في سطر)</label><textarea class="fi" id="keys" rows="5" style="width:100%;font-family:monospace;font-size:11px" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"></textarea></div>
      <button class="btn" style="padding:9px 18px" onclick="imp()">💾 حفظ الأكواد</button>
    </div></div>
    <div class="card" style="overflow-x:auto"><table><thead><tr><th>المنتج</th><th>SKU</th><th>متاح</th><th>مُباع</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table></div>
    <script>async function imp(){const pid=document.getElementById('pid').value;const keys=document.getElementById('keys').value.trim().split('\\n').filter(k=>k.trim().length>5);if(!pid||!keys.length){alert('اختر المنتج وأدخل الأكواد');return;}const r=await fetch('/api/admin/licenses/import',{method:'POST',headers:{Authorization:'Bearer '+localStorage.getItem('adminToken'),'Content-Type':'application/json'},body:JSON.stringify({productId:pid,keys})});const d=await r.json();alert(d.message);if(d.success)location.reload();}</script>`));
});

app.get('/admin/customers', adminCheck, async (req, res) => {
  const custs=await q("SELECT u.*,COUNT(o.id) AS oc,COALESCE(SUM(o.total_sar),0) AS ts FROM users u LEFT JOIN orders o ON o.user_id=u.id AND o.status IN ('completed','processing') WHERE u.role='customer' GROUP BY u.id ORDER BY u.created_at DESC LIMIT 100");
  const rows=custs.map(c=>`<tr><td style="font-weight:600">${c.name}</td><td style="font-size:11px">${c.email}</td><td style="font-weight:700;color:#1ABCEE">${c.oc}</td><td style="font-weight:700">${parseFloat(c.ts||0).toLocaleString('ar-SA')} ر.س</td><td style="font-size:10px;color:#94A3B8">${new Date(c.created_at).toLocaleDateString('ar-SA')}</td></tr>`).join('');
  res.send(layout('العملاء',`<div class="card" style="overflow-x:auto"><table><thead><tr><th>الاسم</th><th>البريد</th><th>الطلبات</th><th>الإجمالي</th><th>تاريخ التسجيل</th></tr></thead><tbody>${rows||'<tr><td colspan="5" style="text-align:center;padding:30px;color:#94A3B8">لا يوجد عملاء</td></tr>'}</tbody></table></div>`));
});

app.get('/admin/reports', adminCheck, async (req, res) => {
  const {from,to}=req.query;
  const df=from||new Date(Date.now()-30*86400000).toISOString().split('T')[0];
  const dt=to||new Date().toISOString().split('T')[0];
  const [tot]=await q("SELECT COUNT(*) AS n,COALESCE(SUM(total_sar),0) AS r,COALESCE(SUM(vat_amount_sar),0) AS v FROM orders WHERE status IN ('completed','processing','paid') AND created_at BETWEEN ? AND ?",[df,dt+' 23:59:59']);
  const daily=await q("SELECT DATE(created_at) AS d,COUNT(*) AS n,SUM(total_sar) AS r FROM orders WHERE status IN ('completed','processing','paid') AND created_at BETWEEN ? AND ? GROUP BY DATE(created_at) ORDER BY d ASC",[df,dt+' 23:59:59']);
  const top=await q("SELECT oi.product_name,COUNT(*) AS n,SUM(oi.total_price_sar) AS r FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status IN ('completed','processing') AND o.created_at BETWEEN ? AND ? GROUP BY oi.product_name ORDER BY r DESC LIMIT 8",[df,dt+' 23:59:59']);
  const drows=daily.map(d=>`<tr><td style="font-size:11px">${d.d}</td><td style="font-weight:700">${d.n}</td><td style="color:#1ABCEE;font-weight:700">${parseFloat(d.r||0).toLocaleString('ar-SA')} ر.س</td></tr>`).join('');
  const trows=top.map(p=>`<tr><td style="font-size:11px;font-weight:600">${p.product_name}</td><td>${p.n}</td><td style="color:#1ABCEE;font-weight:700">${parseFloat(p.r||0).toLocaleString('ar-SA')} ر.س</td></tr>`).join('');
  res.send(layout('التقارير',`
    <div style="display:flex;gap:7px;margin-bottom:10px;align-items:center;flex-wrap:wrap">
      <input type="date" class="fi" value="${df}" id="df"><span>—</span>
      <input type="date" class="fi" value="${dt}" id="dt">
      <button class="btn" onclick="location.href='?from='+document.getElementById('df').value+'&to='+document.getElementById('dt').value">تطبيق</button>
    </div>
    <div class="sg" style="margin-bottom:12px">
      <div class="sc"><div class="sl">إجمالي الطلبات</div><div class="sv" style="color:#1ABCEE">${tot.n}</div></div>
      <div class="sc"><div class="sl">الإيرادات</div><div class="sv">${parseFloat(tot.r||0).toLocaleString('ar-SA')}</div><div class="ss">ريال</div></div>
      <div class="sc"><div class="sl">الضريبة</div><div class="sv" style="color:#7C3AED">${parseFloat(tot.v||0).toLocaleString('ar-SA')}</div><div class="ss">ريال</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:11px">
      <div class="card"><div class="ch"><div class="ct">📅 يومي</div></div><table><thead><tr><th>التاريخ</th><th>طلبات</th><th>الإيراد</th></tr></thead><tbody>${drows||'<tr><td colspan="3" style="text-align:center;padding:20px;color:#94A3B8">لا بيانات</td></tr>'}</tbody></table></div>
      <div class="card"><div class="ch"><div class="ct">🏆 أكثر مبيعاً</div></div><table><thead><tr><th>المنتج</th><th>كمية</th><th>إيراد</th></tr></thead><tbody>${trows||'<tr><td colspan="3" style="text-align:center;padding:20px;color:#94A3B8">لا بيانات</td></tr>'}</tbody></table></div>
    </div>`));
});

app.get('/admin/settings', adminCheck, async (req, res) => {
  const rows=await q('SELECT * FROM settings');
  const cfg={}; rows.forEach(s=>{cfg[s.key_name]=s.value;});
  res.send(layout('الإعدادات',`
    <div class="card"><div class="ch"><div class="ct">⚙️ إعدادات المتجر</div></div>
    <div style="padding:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="fg"><label>اسم المتجر عربي</label><input class="fi" id="store_name_ar" value="${cfg.store_name_ar||''}" style="width:100%"></div>
        <div class="fg"><label>رقم السجل التجاري</label><input class="fi" id="cr_number" value="${cfg.cr_number||''}" style="width:100%"></div>
        <div class="fg"><label>الرقم الضريبي</label><input class="fi" id="vat_number" value="${cfg.vat_number||''}" style="width:100%"></div>
        <div class="fg"><label>بريد الدعم</label><input class="fi" id="support_email" value="${cfg.support_email||''}" style="width:100%"></div>
        <div class="fg"><label>رقم الواتساب</label><input class="fi" id="whatsapp_number" value="${cfg.whatsapp_number||''}" style="width:100%"></div>
        <div class="fg"><label>نسبة الضريبة %</label><input class="fi" id="vat_rate" value="${cfg.vat_rate||'15'}" type="number" style="width:100%"></div>
      </div>
      <button class="btn" style="margin-top:8px;padding:10px 22px" onclick="save()">💾 حفظ الإعدادات</button>
      <div id="msg" style="margin-top:10px;font-size:12px;color:#16A34A;display:none">✅ تم الحفظ بنجاح</div>
    </div></div>
    <script>
    async function save(){
      const tk=localStorage.getItem('adminToken');
      const fields=['store_name_ar','cr_number','vat_number','support_email','whatsapp_number','vat_rate'];
      for(const f of fields){const v=document.getElementById(f)?.value;if(v!==undefined)await fetch('/api/settings',{method:'POST',headers:{Authorization:'Bearer '+tk,'Content-Type':'application/json'},body:JSON.stringify({key:f,value:v})});}
      const m=document.getElementById('msg');m.style.display='block';setTimeout(()=>m.style.display='none',3000);
    }
    </script>`));
});

// ── Health ────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status:'ok', ts:new Date().toISOString(), env:process.env.NODE_ENV }));

// ── 404 ──────────────────────────────────────────
app.use('*', (req, res) => {
  if (req.originalUrl.startsWith('/api')) return res.status(404).json({ success:false, message:'المسار غير موجود' });
  res.redirect('/admin/login');
});

// ── Error ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(err.status||500).json({ success:false, message:process.env.NODE_ENV==='production'?'خطأ داخلي':err.message });
});

// ── Start ─────────────────────────────────────────
(async () => {
  try {
    await setupDB();
    app.listen(PORT, () => {
      console.log(`\n🚀 SOE Backend running on port ${PORT}`);
      console.log(`📊 Admin Panel: http://localhost:${PORT}/admin`);
      console.log(`🔑 Login: admin@soe.com / Admin123!\n`);
    });
  } catch(err) {
    console.error('❌ Startup failed:', err.message);
    process.exit(1);
  }
})();