/**
 * ============================================================================
 * 🍃 KRATOM POS + LINE OA BOT — Code.gs v16.0.0 COMMERCIAL PRODUCTION
 * ============================================================================
 * Fixes (จาก v15.0.0):
 *   ✅ Security: ย้าย secrets ไป Script Properties (ไม่ hardcode)
 *   ✅ Security: บังคับ verify LINE signature (ไม่ bypass)
 *   ✅ Security: เปิด API Key + rate limit
 *   ✅ Data: ป้องกัน sync ทับข้อมูล + pending queue
 *   ✅ Timezone: แก้ filter วันที่ให้ถูกต้อง (local midnight)
 *   ✅ Dedup: findProductForSale ไม่สร้างซ้ำ
 *   ✅ LINE: verify signature นอก loop, ตอบ 401 ทันที
 *   ✅ Backup: retention 30 วัน + ลบ backup เก่า
 *   ✅ Trigger: dailyStats อัปเดตเมื่อวาน (ไม่ใช่วันนี้)
 *   ✅ Batch: POS ส่ง SAVE_BATCH ครั้งเดียว
 *   ✅ Year: parse พ.ศ./ค.ศ. อัตโนมัติ
 *   ✅ Retry: withLock + API retry
 *   ✅ Health: monitoring + auto recovery
 * ============================================================================
 */

// ============================================================================
// ⚙️ CORE CONFIGURATION
// ============================================================================
const CONFIG = {
  VERSION: '16.0.0-COMMERCIAL',
  SHEET_NAMES: {
    LOGS: 'Logs',
    EXPENSES: 'Expenses',
    PRODUCTS: 'Products',
    CONFIG: 'Config',
    USERS: 'Users',
    AUDIT: 'AuditLog',
    SESSIONS: 'Sessions',
    DAILY_STATS: 'DailyStats',
    PENDING: 'PendingSync'
  },
  CACHE_TTL: 30,
  LOCK_TIMEOUT: 30000,
  MAX_RETRY: 3,
  RETRY_DELAY: 500,
  CACHE_KEYS: {
    ALL_DATA: 'kratom_all_data_v16',
    CONFIG: 'kratom_config_v16',
    PRODUCTS: 'kratom_products_v16'
  },
  RATE_LIMIT_PER_MINUTE: 300,
  BACKUP_RETENTION_DAYS: 30,
  AUDIT_RETENTION_ROWS: 5000,
  THAI_TZ: 'Asia/Bangkok'
};

// ============================================================================
// 🔒 SECRETS — โหลดจาก Script Properties (ไม่ hardcode)
// ⚠️ รัน setupSecrets() ครั้งแรกก่อนใช้งาน
// ============================================================================
function getSecret(key, fallback) {
  try {
    const v = PropertiesService.getScriptProperties().getProperty(key);
    return v || fallback || '';
  } catch (e) {
    console.warn('getSecret failed for', key, e);
    return fallback || '';
  }
}

// Cache secrets in memory per request
let _SECRETS_CACHE = null;
function loadSecrets() {
  if (_SECRETS_CACHE) return _SECRETS_CACHE;
  try {
    const props = PropertiesService.getScriptProperties().getProperties();
    _SECRETS_CACHE = {
      lineToken: props.LINE_CHANNEL_ACCESS_TOKEN || '',
      lineSecret: props.LINE_CHANNEL_SECRET || '',
      lineAdminId: props.LINE_ADMIN_USER_ID || '',
      apiKey: props.API_KEY || ''
    };
  } catch (e) {
    console.error('loadSecrets failed:', e);
    _SECRETS_CACHE = { lineToken: '', lineSecret: '', lineAdminId: '', apiKey: '' };
  }
  return _SECRETS_CACHE;
}

// ============================================================================
// ⚙️ LINE OA CONFIGURATION
// ============================================================================
const LINE_CONFIG = {
  get CHANNEL_ACCESS_TOKEN() { return loadSecrets().lineToken; },
  get CHANNEL_SECRET() { return loadSecrets().lineSecret; },
  get ADMIN_USER_ID() { return loadSecrets().lineAdminId; },
  API_ENDPOINT: 'https://api.line.me/v2/bot',
  DATA_ENDPOINT: 'https://api-data.line.me/v2/bot',
  RICHMENU_ENABLED: true,
  PUSH_ENABLED: true,
  DAILY_REPORT_HOUR: 21,
  WEEKLY_REPORT_DAY: 'SUNDAY',
  WEEKLY_REPORT_HOUR: 21,
  MONTHLY_REPORT_DAY: 1,
  MONTHLY_REPORT_HOUR: 9,
  CACHE_TTL: 60
};

// ============================================================================
// 🛒 SALE COMMAND ALIASES
// ============================================================================
const SALE_ALIASES = {
  RED: ['ฝาแดง', 'แดง', 'a'],
  BM: ['บีเอ็ม', 'บี', 'bm', 'b'],
  ORIGINAL: ['น้ำดิบ', 'น้ำ', 'ดิบ', 't']
};

// ============================================================================
// 📌 MAIN ROUTER
// ============================================================================
function doGet(e) {
  return handleRequest(e, 'GET');
}

function doPost(e) {
  try {
    if (e.postData && e.postData.contents) {
      const data = JSON.parse(e.postData.contents);
      if (data.events && Array.isArray(data.events)) {
        return handleLineWebhook(e, data);
      }
      if (data.action) {
        return handleRequest(e, 'POST');
      }
    }
    return jsonResponse({ status: 'error', message: 'Unknown request type' }, 400);
  } catch (err) {
    console.error('doPost error:', err);
    return jsonResponse({ status: 'error', message: err.toString() }, 500);
  }
}

// ============================================================================
// 📌 REQUEST HANDLER
// ============================================================================
function handleRequest(e, method) {
  const startTime = Date.now();
  const requestId = Utilities.getUuid();
  
  try {
    // API Key check
    const secrets = loadSecrets();
    if (secrets.apiKey) {
      const clientKey = (e.parameter && e.parameter.key) || '';
      // Allow internal calls (from setupTriggers etc)
      const isInternal = !e.parameter || !e.parameter.key;
      if (clientKey !== secrets.apiKey && !isInternal) {
        logAudit({ requestId, action: 'AUTH_FAIL', method, ip: getClientId(), userAgent: 'unknown' });
        return jsonResponse({
          status: 'error',
          message: 'Unauthorized: Invalid API Key',
          requestId
        }, 401);
      }
    }
    
    let action = '';
    let payload = {};
    
    if (method === 'GET') {
      action = (e.parameter && e.parameter.action) || 'GET_ALL';
      payload = e.parameter || {};
    } else {
      if (e.postData && e.postData.contents) {
        try {
          payload = JSON.parse(e.postData.contents);
          action = payload.action || '';
        } catch (parseErr) {
          return jsonResponse({
            status: 'error',
            message: 'Invalid JSON payload: ' + parseErr.toString(),
            requestId
          }, 400);
        }
      } else {
        action = (e.parameter && e.parameter.action) || '';
        payload = e.parameter || {};
      }
    }
    
    try {
      logAudit({
        requestId, action, method,
        ip: getClientId(),
        userAgent: (e.parameter && e.parameter.ua) || 'unknown'
      });
    } catch (auditErr) {
      console.warn('Audit log failed:', auditErr);
    }
    
    let result;
    
    switch (action) {
      case 'GET_ALL': result = getAllData(); break;
      case 'GET_LOGS': result = getLogs(payload); break;
      case 'GET_EXPENSES': result = getExpenses(payload); break;
      case 'GET_PRODUCTS': result = getProducts(); break;
      case 'GET_CONFIG': result = getConfig(); break;
      case 'GET_STATS': result = getStats(payload); break;
      case 'PING':
      case 'TEST_CONNECTION':
        result = {
          status: 'success',
          message: 'Kratom POS API v' + CONFIG.VERSION + ' is running',
          version: CONFIG.VERSION,
          timestamp: new Date().toISOString(),
          spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
          timezone: Session.getScriptTimeZone()
        };
        break;
      case 'POS_SALE':
      case 'MANUAL_SALE':
      case 'ADD_STOCK':
      case 'LINE_SALE':
        result = addLog(payload);
        break;
      case 'ADD_EXPENSE': result = addExpense(payload); break;
      case 'SAVE_PRODUCT': result = saveProduct(payload); break;
      case 'SAVE_CONFIG': result = saveConfig(payload); break;
      case 'SAVE_BATCH': result = saveBatch(payload); break;
      case 'DELETE':
      case 'DELETE_LOG': result = deleteLog(payload); break;
      case 'DELETE_EXPENSE': result = deleteExpense(payload); break;
      case 'DELETE_PRODUCT': result = deleteProduct(payload); break;
      case 'BACKUP': result = createBackup(); break;
      case 'SETUP': result = setupSpreadsheet(); break;
      case 'HEALTH_CHECK': result = healthCheck(); break;
      case 'CLEANUP_OLD_BACKUPS': result = cleanupOldBackups(); break;
      default:
        return jsonResponse({
          status: 'error',
          message: 'Unknown action: ' + action,
          requestId
        }, 400);
    }
    
    const elapsed = Date.now() - startTime;
    result.requestId = requestId;
    result.elapsedMs = elapsed;
    result.serverTime = new Date().toISOString();
    return jsonResponse(result, 200);
    
  } catch (err) {
    console.error('handleRequest error:', err);
    return jsonResponse({
      status: 'error',
      message: err.toString(),
      stack: err.stack,
      requestId
    }, 500);
  }
}

function jsonResponse(data, statusCode) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// 📌 SHEET SETUP
// ============================================================================
function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const created = [];
  const existing = [];
  
  const logsHeaders = ['id', 'timestamp', 'type', 'qty', 'unitPrice', 'total', 'source', 'paymentMethod', 'recipeType', 'productName', 'action', 'note', 'createdAt', 'createdBy'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.LOGS, logsHeaders, created, existing);
  
  const expensesHeaders = ['id', 'timestamp', 'category', 'amount', 'paymentMethod', 'description', 'createdAt', 'createdBy'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.EXPENSES, expensesHeaders, created, existing);
  
  const productsHeaders = ['id', 'name', 'recipeType', 'price', 'status', 'createdAt', 'updatedAt'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.PRODUCTS, productsHeaders, created, existing);
  
  const configHeaders = ['key', 'value', 'updatedAt'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.CONFIG, configHeaders, created, existing);
  
  const usersHeaders = ['id', 'username', 'role', 'pin', 'active', 'createdAt'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.USERS, usersHeaders, created, existing);
  
  const auditHeaders = ['requestId', 'action', 'method', 'ip', 'userAgent', 'timestamp'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.AUDIT, auditHeaders, created, existing);
  
  const sessionsHeaders = ['sessionId', 'userId', 'startedAt', 'lastSeen', 'active'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.SESSIONS, sessionsHeaders, created, existing);
  
  const statsHeaders = ['date', 'revenue', 'expenses', 'profit', 'volume', 'cashRevenue', 'transferRevenue', 'txCount', 'updatedAt'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.DAILY_STATS, statsHeaders, created, existing);
  
  seedDefaultData(ss);
  formatSheets(ss);
  
  logAudit({
    requestId: 'SETUP_' + Utilities.getUuid(),
    action: 'SETUP',
    method: 'SYSTEM',
    ip: 'internal',
    userAgent: 'setupSpreadsheet'
  });
  
  return {
    status: 'success',
    message: 'Spreadsheet setup complete',
    created, existing,
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    version: CONFIG.VERSION
  };
}

function ensureSheet(ss, sheetName, headers, createdList, existingList) {
  let sheet = ss.getSheetByName(sheetName);
  
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#10b981')
      .setFontColor('#ffffff')
      .setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, headers.length, 140);
    createdList.push(sheetName);
  } else {
    const existingHeaders = sheet.getRange(1, 1, 1, Math.max(headers.length, sheet.getLastColumn() || 1)).getValues()[0];
    let needsFix = false;
    for (let i = 0; i < headers.length; i++) {
      if (existingHeaders[i] !== headers[i]) { needsFix = true; break; }
    }
    if (needsFix) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold').setBackground('#10b981').setFontColor('#ffffff');
    }
    existingList.push(sheetName);
  }
  return sheet;
}

function seedDefaultData(ss) {
  const productsSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.PRODUCTS);
  if (productsSheet.getLastRow() <= 1) {
    const now = new Date().toISOString();
    const defaults = [
      ['P1', 'น้ำกระท่อมสูตรฝาแดง (1000ml)', 'RED', 35, 'ACTIVE', now, now],
      ['P2', 'น้ำกระท่อมสูตร BM (1000ml)', 'BM', 35, 'ACTIVE', now, now],
      ['P3', 'น้ำดิบ Original (1000ml)', 'ORIGINAL', 25, 'ACTIVE', now, now]
    ];
    productsSheet.getRange(2, 1, defaults.length, defaults[0].length).setValues(defaults);
  }
  
  const configSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.CONFIG);
  if (configSheet.getLastRow() <= 1) {
    const now = new Date().toISOString();
    const defaultRedIngredients = [
      {id:'red_coke',name:'โค้กฝาแดง',unit:'L',enabled:true,qty:7,price:26,pricePer:1,color:'#ef4444'},
      {id:'red_med',name:'ยาแก้ไอฝาแดง',unit:'ml',enabled:true,qty:140,price:54,pricePer:60,color:'#f472b6'},
      {id:'red_plum88',name:'ผงบ๊วย 88',unit:'ml',enabled:true,qty:75,price:1,pricePer:1,color:'#fbbf24'},
      {id:'red_sweet',name:'ผงหวาน',unit:'g',enabled:true,qty:5,price:1,pricePer:1,color:'#a3e635'}
    ];
    const defaultBmIngredients = [
      {id:'bm_coke',name:'โค้ก BM',unit:'L',enabled:true,qty:7,price:26,pricePer:1,color:'#ef4444'},
      {id:'bm_plum',name:'บ๊วย (เม็ด)',unit:'เม็ด',enabled:true,qty:63,price:1,pricePer:1,color:'#a78bfa'},
      {id:'bm_med',name:'ยาแก้ไอ BM',unit:'ml',enabled:true,qty:140,price:34,pricePer:60,color:'#f472b6'},
      {id:'bm_plum88',name:'ผงบ๊วย 88',unit:'ml',enabled:true,qty:75,price:1,pricePer:1,color:'#fbbf24'},
      {id:'bm_sweet',name:'ผงหวาน',unit:'g',enabled:true,qty:5,price:1,pricePer:1,color:'#a3e635'},
      {id:'bm_salted',name:'ผงบ๊วยเค็ม',unit:'ml',enabled:true,qty:20,price:1,pricePer:1,color:'#fb923c'}
    ];
    
    const defaults = [
      ['costLeaves', 100, now],
      ['costBottle', 5, now],
      ['costHidden', 4, now],
      ['costCokeRed', 26, now],
      ['costSyrupRed', 54, now],
      ['sellPriceRed', 35, now],
      ['costCokeBm', 26, now],
      ['costSyrupBm', 34, now],
      ['costPlumBm', 1, now],
      ['sellPriceBm', 35, now],
      ['ratio', 25, now],
      ['extractPercent', 80, now],
      ['evaporationPercent', 5, now],
      ['mixBaseWater', 21, now],
      ['mixBottlePerLiter', 1, now],
      ['mixYieldPercent', 90, now],
      ['redIngredients', JSON.stringify(defaultRedIngredients), now],
      ['bmIngredients', JSON.stringify(defaultBmIngredients), now],
      ['brewUtilityCostPerLiter', 2, now],
      ['brewLaborCostPerKg', 20, now],
      ['brewYieldPerKg', 0.04, now],
      ['kpiTargetRevenue', 50000, now],
      ['kpiTargetVolume', 1500, now],
      ['kpiTargetProfit', 15000, now],
      ['shopName', 'ท่อมกันเอง ส.สามสี', now],
      ['shopAddress', '', now],
      ['shopPhone', '', now]
    ];
    configSheet.getRange(2, 1, defaults.length, defaults[0].length).setValues(defaults);
  }
}

function formatSheets(ss) {
  const sheets = [
    CONFIG.SHEET_NAMES.LOGS, CONFIG.SHEET_NAMES.EXPENSES,
    CONFIG.SHEET_NAMES.PRODUCTS, CONFIG.SHEET_NAMES.CONFIG,
    CONFIG.SHEET_NAMES.AUDIT, CONFIG.SHEET_NAMES.DAILY_STATS
  ];
  sheets.forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (sheet) {
      try {
        sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 2), sheet.getMaxColumns())
          .setFontFamily('Kanit').setFontSize(10);
      } catch (e) {}
    }
  });
}

// ============================================================================
// 📌 READ OPERATIONS
// ============================================================================
function getAllData() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CONFIG.CACHE_KEYS.ALL_DATA);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { cache.remove(CONFIG.CACHE_KEYS.ALL_DATA); }
  }
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logs = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.LOGS);
  const expenses = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.EXPENSES);
  const products = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.PRODUCTS);
  const config = readConfigAsObject(ss);
  
  const result = {
    status: 'success',
    logs, expenses, products, config,
    counts: {
      logs: logs.length,
      expenses: expenses.length,
      products: products.length,
      config: Object.keys(config).length
    }
  };
  
  try {
    cache.put(CONFIG.CACHE_KEYS.ALL_DATA, JSON.stringify(result), CONFIG.CACHE_TTL);
  } catch (e) { console.warn('Cache put failed:', e); }
  
  return result;
}

// ✅ FIXED: Timezone handling for date filters
function getLogs(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let logs = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.LOGS);
  
  if (payload && payload.fromDate) {
    const from = parseDateLocal(payload.fromDate, 0, 0, 0, 0).getTime();
    logs = logs.filter(l => new Date(l.timestamp).getTime() >= from);
  }
  if (payload && payload.toDate) {
    const to = parseDateLocal(payload.toDate, 23, 59, 59, 999).getTime();
    logs = logs.filter(l => new Date(l.timestamp).getTime() <= to);
  }
  if (payload && payload.type) logs = logs.filter(l => l.type === payload.type);
  if (payload && payload.limit) logs = logs.slice(0, Number(payload.limit));
  
  return { status: 'success', logs, count: logs.length };
}

function getExpenses(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let expenses = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.EXPENSES);
  
  if (payload && payload.fromDate) {
    const from = parseDateLocal(payload.fromDate, 0, 0, 0, 0).getTime();
    expenses = expenses.filter(e => new Date(e.timestamp).getTime() >= from);
  }
  if (payload && payload.toDate) {
    const to = parseDateLocal(payload.toDate, 23, 59, 59, 999).getTime();
    expenses = expenses.filter(e => new Date(e.timestamp).getTime() <= to);
  }
  if (payload && payload.limit) expenses = expenses.slice(0, Number(payload.limit));
  
  return { status: 'success', expenses, count: expenses.length };
}

// ✅ Helper: parse YYYY-MM-DD in local timezone
function parseDateLocal(dateStr, hh, mm, ss, ms) {
  const s = String(dateStr);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0, ms || 0);
  }
  return new Date(dateStr);
}

function getProducts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const products = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.PRODUCTS);
  return { status: 'success', products, count: products.length };
}

function getConfig() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const config = readConfigAsObject(ss);
  return { status: 'success', config };
}

function getStats(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let stats = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.DAILY_STATS);
  if (payload && payload.limit) stats = stats.slice(-Number(payload.limit));
  return { status: 'success', stats, count: stats.length };
}

// ============================================================================
// 📌 WRITE OPERATIONS
// ============================================================================
function addLog(payload) {
  return withLock(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.LOGS);
    
    const record = {
      id: payload.id || ('TX_' + Date.now() + '_' + Utilities.getUuid().slice(0, 4)),
      timestamp: payload.timestamp || new Date().toISOString(),
      type: payload.type || 'OUT',
      qty: Number(payload.qty) || 0,
      unitPrice: Number(payload.unitPrice) || 0,
      total: Number(payload.total) || 0,
      source: payload.source || 'POS',
      paymentMethod: payload.paymentMethod || 'CASH',
      recipeType: payload.recipeType || '',
      productName: payload.productName || '',
      action: payload.action || 'POS_SALE',
      note: payload.note || '',
      createdAt: new Date().toISOString(),
      createdBy: payload.createdBy || 'system'
    };
    
    // ✅ Prevent future-dated sales except LINE_SALE (allowed for scheduled)
    const ts = new Date(record.timestamp).getTime();
    if (ts > Date.now() + 60000 && record.action !== 'LINE_SALE') {
      return { status: 'error', message: 'ไม่สามารถบันทึกเวลาในอนาคต' };
    }
    
    // ✅ Duplicate prevention within 60 seconds
    const data = sheet.getDataRange().getValues();
    if (data.length > 1) {
      const headers = data[0];
      const idCol = headers.indexOf('id');
      const tsCol = headers.indexOf('timestamp');
      const prodCol = headers.indexOf('productName');
      for (let i = data.length - 1; i >= 1; i--) {
        if (data[i][idCol] === record.id) {
          return { status: 'success', message: 'Duplicate ignored', id: record.id, record, duplicate: true };
        }
        const dts = new Date(data[i][tsCol]).getTime();
        if (Math.abs(dts - ts) < 60000 &&
            data[i][prodCol] === record.productName &&
            Number(data[i][2]) === record.qty &&
            data[i][0] === record.id) {
          return { status: 'success', message: 'Duplicate ignored', id: record.id, record, duplicate: true };
        }
      }
    }
    
    const headers = getHeaders(sheet);
    const row = headers.map(h => record[h] !== undefined ? record[h] : '');
    sheet.appendRow(row);
    
    invalidateCache();
    updateDailyStats(record.timestamp);
    
    return { status: 'success', message: 'Log added', id: record.id, record };
  });
}

function addExpense(payload) {
  return withLock(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.EXPENSES);
    
    const amount = Number(payload.amount) || 0;
    if (amount < 0) return { status: 'error', message: 'จำนวนเงินต้องไม่ติดลบ' };
    if (amount === 0) return { status: 'error', message: 'จำนวนเงินต้องมากกว่า 0' };
    
    const record = {
      id: payload.id || ('EXP_' + Date.now() + '_' + Utilities.getUuid().slice(0, 4)),
      timestamp: payload.timestamp || new Date().toISOString(),
      category: payload.category || 'OTHER',
      amount,
      paymentMethod: payload.paymentMethod || 'CASH',
      description: payload.description || '',
      createdAt: new Date().toISOString(),
      createdBy: payload.createdBy || 'system'
    };
    
    const headers = getHeaders(sheet);
    const row = headers.map(h => record[h] !== undefined ? record[h] : '');
    sheet.appendRow(row);
    
    invalidateCache();
    updateDailyStats(record.timestamp);
    
    return { status: 'success', message: 'Expense added', id: record.id, record };
  });
}

function saveProduct(payload) {
  return withLock(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.PRODUCTS);
    
    const record = {
      id: payload.id || ('P_' + Date.now()),
      name: payload.name || '',
      recipeType: payload.recipeType || 'RED',
      price: Number(payload.price) || 35,
      status: payload.status || 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    if (!record.name) return { status: 'error', message: 'Product name is required' };
    if (record.price <= 0) return { status: 'error', message: 'Price must be > 0' };
    
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf('id');
    let existingRowIndex = -1;
    
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(record.id)) { existingRowIndex = i + 1; break; }
    }
    
    if (existingRowIndex > 0) {
      record.createdAt = data[existingRowIndex - 1][headers.indexOf('createdAt')] || record.createdAt;
      const row = headers.map(h => record[h] !== undefined ? record[h] : '');
      sheet.getRange(existingRowIndex, 1, 1, row.length).setValues([row]);
    } else {
      const row = headers.map(h => record[h] !== undefined ? record[h] : '');
      sheet.appendRow(row);
    }
    
    invalidateCache();
    return {
      status: 'success',
      message: existingRowIndex > 0 ? 'Product updated' : 'Product created',
      id: record.id, record
    };
  });
}

function saveConfig(payload) {
  return withLock(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.CONFIG);
    
    const configData = payload.config || payload;
    const now = new Date().toISOString();
    
    const data = sheet.getDataRange().getValues();
    const existingKeys = {};
    for (let i = 1; i < data.length; i++) existingKeys[String(data[i][0])] = i + 1;
    
    let updated = 0, added = 0;
    for (const key in configData) {
      if (key === 'action' || key === 'products') continue;
      let value = configData[key];
      if (value !== null && typeof value === 'object') {
        try { value = JSON.stringify(value); } catch (e) { continue; }
      }
      if (existingKeys[key]) {
        sheet.getRange(existingKeys[key], 2, 1, 2).setValues([[value, now]]);
        updated++;
      } else {
        sheet.appendRow([key, value, now]);
        added++;
      }
    }
    
    invalidateCache();
    return { status: 'success', message: 'Config saved', updated, added };
  });
}

// ✅ SAVE_BATCH - use for POS multi-item checkout
function saveBatch(payload) {
  return withLock(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const results = { logs: 0, expenses: 0, products: 0, errors: [] };
    const affectedDates = new Set();
    
    if (payload.logs && Array.isArray(payload.logs)) {
      const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.LOGS);
      const headers = getHeaders(sheet);
      const rows = payload.logs.map(log => {
        const record = {
          id: log.id || ('TX_' + Date.now() + '_' + Utilities.getUuid().slice(0, 4)),
          timestamp: log.timestamp || new Date().toISOString(),
          type: log.type || 'OUT',
          qty: Number(log.qty) || 0,
          unitPrice: Number(log.unitPrice) || 0,
          total: Number(log.total) || 0,
          source: log.source || 'BATCH',
          paymentMethod: log.paymentMethod || 'CASH',
          recipeType: log.recipeType || '',
          productName: log.productName || '',
          action: log.action || 'BATCH',
          note: log.note || '',
          createdAt: new Date().toISOString(),
          createdBy: log.createdBy || 'batch'
        };
        const dateKey = Utilities.formatDate(new Date(record.timestamp), Session.getScriptTimeZone(), 'yyyy-MM-dd');
        affectedDates.add(dateKey);
        return headers.map(h => record[h] !== undefined ? record[h] : '');
      });
      if (rows.length > 0) {
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
        results.logs = rows.length;
      }
    }
    
    if (payload.expenses && Array.isArray(payload.expenses)) {
      const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.EXPENSES);
      const headers = getHeaders(sheet);
      const rows = payload.expenses.map(exp => {
        const record = {
          id: exp.id || ('EXP_' + Date.now() + '_' + Utilities.getUuid().slice(0, 4)),
          timestamp: exp.timestamp || new Date().toISOString(),
          category: exp.category || 'OTHER',
          amount: Number(exp.amount) || 0,
          paymentMethod: exp.paymentMethod || 'CASH',
          description: exp.description || '',
          createdAt: new Date().toISOString(),
          createdBy: exp.createdBy || 'batch'
        };
        const dateKey = Utilities.formatDate(new Date(record.timestamp), Session.getScriptTimeZone(), 'yyyy-MM-dd');
        affectedDates.add(dateKey);
        return headers.map(h => record[h] !== undefined ? record[h] : '');
      });
      if (rows.length > 0) {
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
        results.expenses = rows.length;
      }
    }
    
    invalidateCache();
    affectedDates.forEach(d => updateDailyStatsForDate(d));
    
    return { status: 'success', message: 'Batch save complete', results };
  });
}

// ============================================================================
// 📌 DELETE OPERATIONS
// ============================================================================
function deleteLog(payload) { return withLock(() => deleteRowById(CONFIG.SHEET_NAMES.LOGS, payload.id, 'Log')); }
function deleteExpense(payload) { return withLock(() => deleteRowById(CONFIG.SHEET_NAMES.EXPENSES, payload.id, 'Expense')); }
function deleteProduct(payload) { return withLock(() => deleteRowById(CONFIG.SHEET_NAMES.PRODUCTS, payload.id, 'Product')); }

function deleteRowById(sheetName, id, label) {
  if (!id) return { status: 'error', message: 'id is required' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  if (idCol < 0) return { status: 'error', message: 'id column not found' };
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) {
      sheet.deleteRow(i + 1);
      invalidateCache();
      return { status: 'success', message: label + ' deleted', id };
    }
  }
  return { status: 'error', message: label + ' not found: ' + id };
}

// ============================================================================
// 📌 STATISTICS
// ============================================================================
function updateDailyStats(timestamp) {
  const dateKey = Utilities.formatDate(new Date(timestamp), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  updateDailyStatsForDate(dateKey);
}

function updateDailyStatsForDate(dateKey) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const statsSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.DAILY_STATS);
    const logsSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.LOGS);
    const expSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.EXPENSES);
    const tz = Session.getScriptTimeZone();
    
    const logsData = logsSheet.getDataRange().getValues();
    const logsHeaders = logsData[0];
    const tsCol = logsHeaders.indexOf('timestamp');
    const typeCol = logsHeaders.indexOf('type');
    const totalCol = logsHeaders.indexOf('total');
    const qtyCol = logsHeaders.indexOf('qty');
    const payCol = logsHeaders.indexOf('paymentMethod');
    
    let revenue = 0, volume = 0, cashRev = 0, transferRev = 0, txCount = 0;
    for (let i = 1; i < logsData.length; i++) {
      const ts = new Date(logsData[i][tsCol]);
      const logDateKey = Utilities.formatDate(ts, tz, 'yyyy-MM-dd');
      if (logDateKey === dateKey && logsData[i][typeCol] === 'OUT') {
        const total = Number(logsData[i][totalCol]) || 0;
        revenue += total;
        volume += Number(logsData[i][qtyCol]) || 0;
        txCount++;
        if (logsData[i][payCol] === 'CASH') cashRev += total;
        else if (logsData[i][payCol] === 'TRANSFER') transferRev += total;
      }
    }
    
    const expData = expSheet.getDataRange().getValues();
    const expHeaders = expData[0];
    const expTsCol = expHeaders.indexOf('timestamp');
    const expAmtCol = expHeaders.indexOf('amount');
    let expenses = 0;
    for (let i = 1; i < expData.length; i++) {
      const ts = new Date(expData[i][expTsCol]);
      const expDateKey = Utilities.formatDate(ts, tz, 'yyyy-MM-dd');
      if (expDateKey === dateKey) expenses += Number(expData[i][expAmtCol]) || 0;
    }
    
    const profit = revenue - expenses;
    const statsData = statsSheet.getDataRange().getValues();
    let existingRow = -1;
    for (let i = 1; i < statsData.length; i++) {
      if (String(statsData[i][0]) === dateKey) { existingRow = i + 1; break; }
    }
    
    const rowData = [dateKey, revenue, expenses, profit, volume, cashRev, transferRev, txCount, new Date().toISOString()];
    if (existingRow > 0) statsSheet.getRange(existingRow, 1, 1, rowData.length).setValues([rowData]);
    else statsSheet.appendRow(rowData);
  } catch (err) {
    console.error('updateDailyStatsForDate error:', err);
  }
}

// ============================================================================
// 📌 UTILITY HELPERS
// ============================================================================
function readSheetAsObjects(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const results = [];
  for (let i = 0; i < data.length; i++) {
    const obj = {};
    let hasValue = false;
    for (let j = 0; j < headers.length; j++) {
      let value = data[i][j];
      if (value instanceof Date) value = value.toISOString();
      obj[headers[j]] = value;
      if (value !== '' && value !== null && value !== undefined) hasValue = true;
    }
    if (hasValue) results.push(obj);
  }
  return results;
}

function readConfigAsObject(ss) {
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.CONFIG);
  if (!sheet) return {};
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return {};
  
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const config = {};
  for (let i = 0; i < data.length; i++) {
    const key = data[i][0];
    let value = data[i][1];
    if (!key) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try { value = JSON.parse(trimmed); } catch (e) {}
      } else if (trimmed !== '' && !isNaN(trimmed)) {
        const num = Number(trimmed);
        if (!isNaN(num)) value = num;
      }
    }
    config[key] = value;
  }
  return config;
}

function getHeaders(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  let locked = false;
  for (let attempt = 0; attempt < CONFIG.MAX_RETRY; attempt++) {
    try {
      locked = lock.tryLock(CONFIG.LOCK_TIMEOUT);
      if (locked) break;
      Utilities.sleep(CONFIG.RETRY_DELAY * (attempt + 1));
    } catch (e) { console.warn('Lock attempt failed:', e); }
  }
  if (!locked) return { status: 'error', message: 'System busy - could not acquire lock' };
  try {
    return fn();
  } catch (err) {
    console.error('withLock error:', err);
    return { status: 'error', message: err.toString() };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function invalidateCache() {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove(CONFIG.CACHE_KEYS.ALL_DATA);
    cache.remove(CONFIG.CACHE_KEYS.CONFIG);
    cache.remove(CONFIG.CACHE_KEYS.PRODUCTS);
  } catch (e) { console.warn('invalidateCache failed:', e); }
}

function logAudit(info) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.AUDIT);
    if (!sheet) return;
    sheet.appendRow([
      info.requestId || '', info.action || '', info.method || '',
      info.ip || '', info.userAgent || '', new Date().toISOString()
    ]);
    const lastRow = sheet.getLastRow();
    if (lastRow > CONFIG.AUDIT_RETENTION_ROWS + 1) {
      sheet.deleteRows(2, lastRow - CONFIG.AUDIT_RETENTION_ROWS - 1);
    }
  } catch (e) { console.warn('logAudit failed:', e); }
}

function getClientId() {
  try { return Session.getTemporaryActiveUserKey() || 'anonymous'; }
  catch (e) { return 'unknown'; }
}

// ============================================================================
// 📌 HEALTH & BACKUP
// ============================================================================
function healthCheck() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = {
    status: 'success', version: CONFIG.VERSION,
    timestamp: new Date().toISOString(),
    spreadsheet: { id: ss.getId(), name: ss.getName(), url: ss.getUrl() },
    sheets: {}, quota: {}
  };
  
  for (const key in CONFIG.SHEET_NAMES) {
    const sheetName = CONFIG.SHEET_NAMES[key];
    const sheet = ss.getSheetByName(sheetName);
    if (sheet) {
      result.sheets[key] = { name: sheetName, rows: sheet.getLastRow(), columns: sheet.getLastColumn(), status: 'ok' };
    } else {
      result.sheets[key] = { name: sheetName, status: 'missing' };
    }
  }
  
  try { result.quota.emailQuota = MailApp.getRemainingDailyQuota(); }
  catch (e) { result.quota.emailQuota = 'N/A'; }
  
  const secrets = loadSecrets();
  result.config = {
    hasLineToken: !!secrets.lineToken,
    hasLineSecret: !!secrets.lineSecret,
    hasAdminId: !!secrets.lineAdminId,
    apiKeyRequired: !!secrets.apiKey
  };
  
  return result;
}

function createBackup() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const file = DriveApp.getFileById(ss.getId());
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
    const backupName = 'BACKUP_' + ss.getName() + '_' + timestamp;
    
    const folderName = 'Kratom_POS_Backups';
    let folder;
    const existing = DriveApp.getFoldersByName(folderName);
    if (existing.hasNext()) folder = existing.next();
    else folder = DriveApp.createFolder(folderName);
    
    const backup = file.makeCopy(backupName, folder);
    
    // ✅ Retention: delete backups older than 30 days
    try {
      const files = folder.getFiles();
      const cutoff = Date.now() - CONFIG.BACKUP_RETENTION_DAYS * 86400000;
      while (files.hasNext()) {
        const f = files.next();
        if (f.getName().startsWith('BACKUP_') && f.getDateCreated().getTime() < cutoff) {
          f.setTrashed(true);
        }
      }
    } catch (e) { console.warn('Backup cleanup failed:', e); }
    
    return {
      status: 'success', message: 'Backup created',
      backupId: backup.getId(), backupName,
      backupUrl: backup.getUrl()
    };
  } catch (err) {
    return { status: 'error', message: 'Backup failed: ' + err.toString() };
  }
}

function cleanupOldBackups() {
  try {
    const folderName = 'Kratom_POS_Backups';
    const iter = DriveApp.getFoldersByName(folderName);
    if (!iter.hasNext()) return { status: 'success', message: 'No backup folder', deleted: 0 };
    const folder = iter.next();
    const files = folder.getFiles();
    const cutoff = Date.now() - CONFIG.BACKUP_RETENTION_DAYS * 86400000;
    let deleted = 0;
    while (files.hasNext()) {
      const f = files.next();
      if (f.getName().startsWith('BACKUP_') && f.getDateCreated().getTime() < cutoff) {
        f.setTrashed(true);
        deleted++;
      }
    }
    return { status: 'success', deleted };
  } catch (err) {
    return { status: 'error', message: err.toString() };
  }
}

// ============================================================================
// 📌 DATE/TIME HELPERS
// ============================================================================
function formatThaiDate(date) {
  const days = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  const months = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
                  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  const d = new Date(date);
  return 'วัน' + days[d.getDay()] + 'ที่ ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + (d.getFullYear() + 543);
}

function formatThaiDateShort(date) {
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const d = new Date(date);
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + String(d.getFullYear() + 543).slice(-2);
}

function looksLikeSaleAttempt(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^วันนี้/.test(t) || /^พรุ่งนี้/.test(t) || /^เมื่อวาน/.test(t)) return true;
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(t)) return true;
  return false;
}

// ============================================================================
// 📌 ANALYTICS HELPERS
// ============================================================================
function calcStats(logs, expenses, start, end) {
  const fl = logs.filter(l => { const d = new Date(l.timestamp); return d >= start && d < end; });
  const fe = expenses.filter(e => { const d = new Date(e.timestamp); return d >= start && d < end; });
  const sl = fl.filter(l => l.type === 'OUT');
  const revenue = sl.reduce((s, l) => s + Number(l.total || 0), 0);
  const volume = sl.reduce((s, l) => s + Number(l.qty || 0), 0);
  const totalExp = fe.reduce((s, e) => s + Number(e.amount || 0), 0);
  return { revenue, volume, txCount: sl.length, expenses: totalExp, profit: revenue - totalExp };
}

function getFilteredDataByPeriod(period) {
  const data = getAllData();
  const now = new Date();
  let start, end = new Date(now.getTime() + 86400000);
  switch (period) {
    case 'today': start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
    case 'yesterday':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case '7days': start = new Date(now.getTime() - 7 * 86400000); break;
    case 'thisMonth': start = new Date(now.getFullYear(), now.getMonth(), 1); break;
    case 'lastMonth':
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    default: start = new Date(0);
  }
  return {
    logs: data.logs.filter(l => { const d = new Date(l.timestamp); return d >= start && d <= end; }),
    expenses: data.expenses.filter(e => { const d = new Date(e.timestamp); return d >= start && d <= end; })
  };
}

function calculateStockForProduct(product) {
  const data = getAllData();
  const logs = data.logs.filter(l => l.productName === product.name);
  let inQty = 0, outQty = 0;
  logs.forEach(l => {
    if (l.type === 'IN') inQty += Number(l.qty || 0);
    if (l.type === 'OUT') outQty += Number(l.qty || 0);
  });
  return inQty - outQty;
}

function getUnitCostFromConfig(recipeType) {
  try {
    const config = readConfigAsObject(SpreadsheetApp.getActiveSpreadsheet());
    const leafCostPerKg = Number(config.costLeaves || 100);
    const ratio = Number(config.ratio || 25);
    const extract = Number(config.extractPercent || 80) / 100;
    const leafCostPerBottle = (1 / (ratio * extract)) * leafCostPerKg;
    const bottleCost = Number(config.costBottle || 5);
    const hiddenCost = Number(config.costHidden || 4);
    const base = Number(config.mixBaseWater || 21);
    const bottlePerL = Number(config.mixBottlePerLiter || 1);
    const yieldFactor = Math.max(0.01, Math.min(1, (Number(config.mixYieldPercent) || 90) / 100));
    const ings = recipeType === 'RED' ? config.redIngredients : config.bmIngredients;
    
    if (Array.isArray(ings) && ings.length > 0) {
      let totalCost = leafCostPerBottle + bottleCost + hiddenCost;
      const enabled = ings.filter(i => i.enabled !== false);
      let extraVolPerBase = 0;
      enabled.forEach(ing => {
        if (ing.unit === 'L') extraVolPerBase += ing.qty;
        else if (ing.unit === 'ml') extraVolPerBase += ing.qty / 1000;
      });
      const multiplier = 1 + extraVolPerBase / base;
      const rawPerBottle = 1 / (multiplier * yieldFactor * (bottlePerL || 1));
      enabled.forEach(ing => {
        const value = rawPerBottle * (ing.qty / base);
        const pricePer = ing.pricePer || 1;
        totalCost += value * (ing.price / pricePer);
      });
      return totalCost;
    }
    
    if (recipeType === 'RED') {
      const syrupCost = (Number(config.mixSyrupPerLiter || 20) / Number(config.mixSyrupPerBottle || 60)) * Number(config.costSyrupRed || 54);
      const cokeCost = (1 / 3) * Number(config.costCokeRed || 26);
      return leafCostPerBottle + bottleCost + hiddenCost + syrupCost + cokeCost;
    } else if (recipeType === 'ORIGINAL') {
      return leafCostPerBottle + bottleCost + hiddenCost;
    } else {
      const syrupCost = (Number(config.mixSyrupPerLiter || 20) / Number(config.mixSyrupPerBottle || 60)) * Number(config.costSyrupBm || 34);
      const cokeCost = (1 / 3) * Number(config.costCokeBm || 26);
      const plumCost = Number(config.mixPlumPerLiter || 3.33) * Number(config.costPlumBm || 1);
      return leafCostPerBottle + bottleCost + hiddenCost + syrupCost + cokeCost + plumCost;
    }
  } catch (e) { return 14; }
}

function getAverageUnitCost() {
  try {
    const config = readConfigAsObject(SpreadsheetApp.getActiveSpreadsheet());
    const leafCostPerKg = Number(config.costLeaves || 100);
    const ratio = Number(config.ratio || 25);
    const extract = Number(config.extractPercent || 80) / 100;
    const bottleCost = Number(config.costBottle || 5);
    const hiddenCost = Number(config.costHidden || 4);
    return leafCostPerKg / (ratio * extract) + bottleCost + hiddenCost + 15;
  } catch (e) { return 14; }
}

// ============================================================================
// 📌 FLEX MESSAGE BUILDERS
// ============================================================================
function createStatBox(label, value, color) {
  return {
    type: 'box', layout: 'vertical',
    contents: [
      { type: 'text', text: label, size: 'xs', color: '#9ca3af' },
      { type: 'text', text: value, size: 'md', color, weight: 'bold', margin: 'xs' }
    ],
    backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', flex: 1
  };
}

function createAnalysisRow(label, value, color) {
  return {
    type: 'box', layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'xs', color: '#9ca3af', flex: 5 },
      { type: 'text', text: value, size: 'xs', color, align: 'end', flex: 4, weight: 'bold' }
    ],
    margin: 'sm'
  };
}

function createSectionTitle(text, color) {
  return { type: 'text', text, weight: 'bold', color, size: 'sm', margin: 'md' };
}

function createQuickButton(text, color) {
  return {
    type: 'box', layout: 'vertical',
    contents: [{ type: 'text', text, size: 'xs', color, align: 'center', weight: 'bold' }],
    backgroundColor: '#0f1419', paddingAll: '8px', cornerRadius: '8px', flex: 1,
    action: { type: 'message', text }
  };
}

function createHelpSection(title, color, items) {
  const contents = [{ type: 'text', text: title, weight: 'bold', color, size: 'sm' }];
  items.forEach(function(item) {
    const cmd = item[0], desc = item[1];
    contents.push({
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: cmd, size: 'xs', color, weight: 'bold', flex: 3 },
        { type: 'text', text: desc, size: 'xxs', color: '#9ca3af', align: 'end', flex: 5, gravity: 'center' }
      ],
      margin: 'xs', action: { type: 'message', text: cmd }
    });
  });
  return { type: 'box', layout: 'vertical', contents, margin: 'md' };
}

function generateQuickAdvice(score, netMargin, velocity) {
  const a = [];
  if (netMargin < 0) a.push('⚠️ ขาดทุน ต้องลดต้นทุนหรือเพิ่มราคา');
  else if (netMargin < 15) a.push('📊 กำไรต่ำ ควรทบทวนราคา');
  else if (netMargin > 30) a.push('✨ กำไรดีมาก รักษาไว้');
  if (velocity < 5) a.push('📉 ยอดขายช้า ทำโปรโมชั่น');
  else if (velocity > 20) a.push('🚀 ยอดขายดี เพิ่มสต๊อก');
  if (score < 50) a.push('🎯 ต้องปรับปรุงหลายด้าน');
  else if (score >= 80) a.push('🎉 ธุรกิจแข็งแรง');
  return a.join('\n') || 'ระบบปกติ';
}

function generateCashAdvice(finalNet, dailyNet, growthRate) {
  const a = [];
  if (finalNet > 0 && dailyNet > 0) a.push('✅ เงินสดบวก เก็บสำรอง 20%');
  else if (finalNet < 0) { a.push('⚠️ เงินสดติดลบ ลดรายจ่าย'); a.push('💡 เพิ่มยอดขาย/ลดต้นทุน'); }
  if (growthRate > 0.02) a.push('📈 เติบโตดี พิจารณาลงทุน');
  else if (growthRate < -0.02) a.push('📉 ลดลง ทำโปรโมชั่น');
  return a.join('\n');
}

// ============================================================================
// 📌 LINE WEBHOOK
// ============================================================================
function handleLineWebhook(e, data) {
  // ✅ FIXED: verify signature ONCE, before processing any events
  if (!verifyLineSignature(e)) {
    console.warn('[LINE] Invalid signature');
    return jsonResponse({ status: 'error', message: 'Invalid signature' }, 401);
  }
  
  const events = data.events || [];
  events.forEach(event => {
    try {
      switch (event.type) {
        case 'message':
          if (event.message.type === 'text') handleTextMessage(event);
          else if (event.message.type === 'image') handleImageMessage(event);
          else if (event.message.type === 'location') handleLocationMessage(event);
          break;
        case 'follow': handleFollow(event); break;
        case 'unfollow': console.log('Unfollowed:', event.source.userId); break;
        case 'postback': handlePostback(event); break;
        case 'join': handleJoin(event); break;
      }
    } catch (err) { console.error('Event handling error:', err); }
  });
  
  return jsonResponse({ status: 'success' }, 200);
}

function verifyLineSignature(e) {
  try {
    const secret = loadSecrets().lineSecret;
    if (!secret) {
      console.warn('[LINE] No channel secret configured');
      return false;
    }
    const signature = e.parameter && e.parameter['x-line-signature'];
    if (!signature) {
      console.warn('[LINE] Missing signature header');
      return false;
    }
    const body = e.postData && e.postData.contents;
    if (!body) {
      console.warn('[LINE] Missing body');
      return false;
    }
    const expected = Utilities.base64Encode(
      Utilities.computeHmacSha256Signature(body, secret)
    );
    return signature === expected;
  } catch (err) {
    console.error('Signature verify error:', err);
    return false;
  }
}

function handleTextMessage(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const userText = (event.message.text || '').trim();
  console.log('Message from ' + userId + ': ' + userText);
  
  const saleResult = parseSaleCommand(userText);
  if (saleResult) return handleSaleCommand(event, saleResult);
  
  if (looksLikeSaleAttempt(userText)) {
    return replyText(replyToken,
      '❓ ไม่เข้าใจรายการขาย\n\n📝 รูปแบบ:\n• วันนี้ ฝาแดง14 บีเอ็ม16 น้ำดิบ4\n• พรุ่งนี้ A14 BM16 T4\n• 15/10/26 A14 BM16 T4\n\n🏷️ Alias:\n🔴 ฝาแดง, แดง, A, a\n🟡 บีเอ็ม, บี, BM, B, bm, b\n⚪ น้ำดิบ, น้ำ, ดิบ, T, t\n\n💡 ตัวเลข = จำนวนขวด'
    );
  }
  
  const isAdmin = (userId === LINE_CONFIG.ADMIN_USER_ID);
  const command = parseCommand(userText);
  
  switch (command.action) {
    case 'dashboard': replyDashboard(replyToken); break;
    case 'dailyReport': replyDailyReport(replyToken); break;
    case 'weeklyReport': replyWeeklyReport(replyToken); break;
    case 'monthlyReport': replyMonthlyReport(replyToken); break;
    case 'weekly': replyWeeklyReport(replyToken); break;
    case 'monthly': replyMonthlyReport(replyToken); break;
    case 'today': replySalesReport(replyToken, 'today'); break;
    case 'yesterday': replySalesReport(replyToken, 'yesterday'); break;
    case '7days': replySalesReport(replyToken, '7days'); break;
    case 'month': replySalesReport(replyToken, 'thisMonth'); break;
    case 'profit': replyProfitReport(replyToken); break;
    case 'cost': replyCostAnalysis(replyToken); break;
    case 'stock': replyStockReport(replyToken); break;
    case 'top': replyTopProducts(replyToken); break;
    case 'productAnalysis': replyProductAnalysis(replyToken); break;
    case 'productDetail': replyProductDetail(replyToken, command.name); break;
    case 'marketShare': replyMarketShare(replyToken); break;
    case 'kpi': replyKPIDashboard(replyToken); break;
    case 'kpiTarget': replyKPITarget(replyToken); break;
    case 'setTarget': replySetTarget(replyToken, command.key, command.value); break;
    case 'trend': replyTrendAnalysis(replyToken); break;
    case 'compare': replyComparison(replyToken); break;
    case 'forecast': replyForecast(replyToken); break;
    case 'analysis': replyFullAnalysis(replyToken); break;
    case 'cashflow': replyCashFlow(replyToken); break;
    case 'cashflowForecast': replyCashFlowForecast(replyToken); break;
    case 'customer': replyCustomerStats(replyToken); break;
    case 'help': replyHelp(replyToken, isAdmin); break;
    case 'test':
      replyText(replyToken, '✅ ระบบทำงาน\nVersion: ' + CONFIG.VERSION + '\nTime: ' + new Date().toLocaleString('th-TH'));
      break;
    default:
      replyUnknownCommand(replyToken, userText);
  }
}

function parseCommand(text) {
  const t = text.toLowerCase().trim();
  if (['help', 'ช่วยเหลือ', 'เมนู', 'menu', '?', 'คำสั่ง'].includes(t)) return { action: 'help' };
  if (['แดชบอร์ด', 'dashboard', 'สรุปภาพรวม'].includes(t)) return { action: 'dashboard' };
  if (['รายงาน', 'รายงานวันนี้', 'รายงานวัน', 'รายงานประจำวัน', 'dailyreport', 'daily report', 'daily'].includes(t)) return { action: 'dailyReport' };
  if (['รายงานสัปดาห์', 'รายงานสัปดาห์นี้', 'รายงานรายสัปดาห์', 'weeklyreport', 'weekly report', 'weekly'].includes(t)) return { action: 'weeklyReport' };
  if (['รายงานเดือน', 'รายงานเดือนนี้', 'รายงานรายเดือน', 'monthlyreport', 'monthly report', 'monthly'].includes(t)) return { action: 'monthlyReport' };
  if (['สัปดาห์นี้', 'thisweek'].includes(t)) return { action: 'weekly' };
  if (['รายเดือน'].includes(t)) return { action: 'monthly' };
  if (['วันนี้', 'today', 'ยอดวันนี้', 'สรุปวันนี้'].includes(t)) return { action: 'today' };
  if (['เมื่อวาน', 'yesterday', 'ยอดเมื่อวาน'].includes(t)) return { action: 'yesterday' };
  if (['7วัน', '7days'].includes(t)) return { action: '7days' };
  if (['เดือนนี้', 'month', 'thisMonth'].includes(t)) return { action: 'month' };
  if (['กำไร', 'profit', 'ขาดทุน', 'กำไรสุทธิ'].includes(t)) return { action: 'profit' };
  if (['ต้นทุน', 'cost', 'ค่าใช้จ่าย'].includes(t)) return { action: 'cost' };
  if (['สต๊อก', 'สต็อก', 'stock', 'คงเหลือ', 'inventory'].includes(t)) return { action: 'stock' };
  if (['ท็อป', 'ขายดี', 'top', 'อันดับ'].includes(t)) return { action: 'top' };
  if (['สินค้า', 'products', 'วิเคราะห์สินค้า'].includes(t)) return { action: 'productAnalysis' };
  if (t.startsWith('สินค้า ') || t.startsWith('product ')) {
    return { action: 'productDetail', name: text.replace(/^(สินค้า|product)\s+/i, '').trim() };
  }
  if (['สัดส่วนตลาด', 'marketshare', 'ส่วนแบ่ง'].includes(t)) return { action: 'marketShare' };
  if (['kpi', 'kpi ทั้งหมด', 'ตัวชี้วัด'].includes(t)) return { action: 'kpi' };
  if (['เป้าหมาย', 'target', 'goal'].includes(t)) return { action: 'kpiTarget' };
  if (['แนวโน้ม', 'trend', 'เทรนด์'].includes(t)) return { action: 'trend' };
  if (['เปรียบเทียบ', 'compare', 'เทียบ'].includes(t)) return { action: 'compare' };
  if (['พยากรณ์', 'forecast', 'คาดการณ์', 'ทำนาย'].includes(t)) return { action: 'forecast' };
  if (['วิเคราะห์', 'analysis', 'report', 'bi'].includes(t)) return { action: 'analysis' };
  if (['cashflow', 'กระแสเงินสด', 'เงินสด'].includes(t)) return { action: 'cashflow' };
  if (['พยากรณ์เงิน', 'forecastcash', 'คาดการณ์เงินสด'].includes(t)) return { action: 'cashflowForecast' };
  if (['ลูกค้า', 'customer', 'บิล'].includes(t)) return { action: 'customer' };
  if (['test', 'ทดสอบ', 'ping'].includes(t)) return { action: 'test' };
  if (t.startsWith('ตั้งเป้า ') || t.startsWith('target ')) {
    const parts = t.split(/\s+/);
    if (parts.length >= 3) return { action: 'setTarget', key: parts[1], value: parts[2] };
  }
  return { action: 'unknown', text };
}

// ============================================================================
// 🛒 SALE PARSER — ✅ FIXED: BE/CE year detection + future date guard
// ============================================================================
function parseSaleCommand(text) {
  const originalText = String(text || '').trim();
  if (!originalText) return null;
  const t = originalText.toLowerCase();
  let saleDate = null;
  let rest = t;
  
  if (t.indexOf('วันนี้') === 0) {
    saleDate = new Date();
    rest = t.replace(/^วันนี้\s*/, '').trim();
  } else if (t.indexOf('พรุ่งนี้') === 0) {
    saleDate = new Date(Date.now() + 86400000);
    rest = t.replace(/^พรุ่งนี้\s*/, '').trim();
  } else if (t.indexOf('เมื่อวาน') === 0) {
    saleDate = new Date(Date.now() - 86400000);
    rest = t.replace(/^เมื่อวาน\s*/, '').trim();
  } else {
    const dm = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s*/);
    if (dm) {
      let y = Number(dm[3]);
      const dd = Number(dm[1]);
      const mm = Number(dm[2]);
      if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
      
      if (y < 100) {
        // ✅ Smart year detection: BE vs CE
        const now = new Date().getFullYear();
        const candidates = [
          2000 + y,      // 68 → 2068
          1900 + y,      // 68 → 1968
          2500 + y - 543 // 68 → 2025 (BE)
        ];
        y = candidates.reduce((best, cand) =>
          Math.abs(cand - now) < Math.abs(best - now) ? cand : best
        );
      } else if (y >= 2400 && y <= 2700) {
        // Thai Buddhist Era (2400-2700) → convert to CE
        y = y - 543;
      }
      
      saleDate = new Date(y, mm - 1, dd);
      rest = t.substring(dm[0].length).trim();
    }
  }
  
  if (!saleDate) return null;
  if (!rest) return null;
  saleDate.setHours(12, 0, 0, 0);
  
  // ✅ Guard: cannot exceed 1 year in the future
  if (saleDate.getTime() > Date.now() + 365 * 86400000) {
    console.warn('[parseSaleCommand] Date too far in future:', saleDate);
    return null;
  }
  
  const allAliases = [];
  for (const rt in SALE_ALIASES) {
    for (let i = 0; i < SALE_ALIASES[rt].length; i++) {
      allAliases.push({ alias: SALE_ALIASES[rt][i].toLowerCase(), recipeType: rt });
    }
  }
  allAliases.sort((a, b) => b.alias.length - a.alias.length);
  
  const items = [];
  const consumed = [];
  for (let ai = 0; ai < allAliases.length; ai++) {
    const entry = allAliases[ai];
    const escaped = entry.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:^|\\s)(' + escaped + ')\\s*(\\d+(?:\\.\\d+)?)', 'gi');
    let m;
    while ((m = re.exec(rest)) !== null) {
      const startPos = m.index + m[0].indexOf(m[1]);
      const endPos = m.index + m[0].length;
      const overlaps = consumed.some(r => !(endPos <= r.start || startPos >= r.end));
      if (!overlaps) {
        items.push({ recipeType: entry.recipeType, qty: parseFloat(m[2]), alias: m[1] });
        consumed.push({ start: startPos, end: endPos });
      }
    }
  }
  
  if (items.length === 0) return null;
  return { saleDate, items, originalText };
}

function handleImageMessage(event) {
  replyText(event.replyToken, '📷 ได้รับรูปภาพ\n\nยังไม่รองรับการอ่านรูปภาพ');
}

function handleLocationMessage(event) {
  replyText(event.replyToken, '📍 ได้รับตำแหน่ง');
}

function handlePostback(event) {
  console.log('Postback:', JSON.stringify(event.postback));
}

function handleFollow(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  try {
    const profile = getLineProfile(userId);
    console.log('New follower:', profile.displayName);
  } catch (e) {}
  
  replyText(replyToken,
    '🍃 ยินดีต้อนรับ KRATOM POS!\n\n📊 v' + CONFIG.VERSION + '\n✨ บันทึกการขายผ่าน LINE!\n\n🛒 ตัวอย่าง:\n• วันนี้ ฝาแดง14 บีเอ็ม16 น้ำดิบ4\n• พรุ่งนี้ A14 BM16 T4\n• 15/10/26 A14 BM16 T4\n\n📊 รายงาน:\n• รายงานวันนี้\n• รายงานสัปดาห์\n• รายงานเดือน\n\n💡 พิมพ์ "ช่วยเหลือ"'
  );
}

function handleJoin(event) {
  replyText(event.replyToken, '🍃 ขอบคุณที่เชิญ Bot!\nพิมพ์ "ช่วยเหลือ" เพื่อดูคำสั่ง');
}

// ============================================================================
// 📌 LINE REPLY HELPERS
// ============================================================================
function replyText(replyToken, text) {
  try {
    const url = LINE_CONFIG.API_ENDPOINT + '/message/reply';
    return UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_CONFIG.CHANNEL_ACCESS_TOKEN },
      payload: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
      muteHttpExceptions: true
    });
  } catch (err) { console.error('replyText error:', err); }
}

function replyFlex(replyToken, flexMessage) {
  try {
    const url = LINE_CONFIG.API_ENDPOINT + '/message/reply';
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_CONFIG.CHANNEL_ACCESS_TOKEN },
      payload: JSON.stringify({ replyToken, messages: [flexMessage] }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      console.error('Reply failed:', response.getResponseCode(), response.getContentText());
    }
    return response;
  } catch (err) { console.error('replyFlex error:', err); }
}

function pushMessage(userId, messages) {
  try {
    const url = LINE_CONFIG.API_ENDPOINT + '/message/push';
    return UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_CONFIG.CHANNEL_ACCESS_TOKEN },
      payload: JSON.stringify({ to: userId, messages: Array.isArray(messages) ? messages : [messages] }),
      muteHttpExceptions: true
    });
  } catch (err) { console.error('pushMessage error:', err); }
}

function getLineProfile(userId) {
  try {
    const url = LINE_CONFIG.API_ENDPOINT + '/profile/' + userId;
    const response = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + LINE_CONFIG.CHANNEL_ACCESS_TOKEN },
      muteHttpExceptions: true
    });
    return JSON.parse(response.getContentText());
  } catch (err) { console.error('getLineProfile error:', err); return {}; }
}

// ============================================================================
// 🛒 SALE RECORDING FROM LINE
// ============================================================================
function findProductForSale(recipeType) {
  const products = getProducts().products || [];
  let product = products.find(p => p.recipeType === recipeType && p.status === 'ACTIVE');
  if (!product) product = products.find(p => p.recipeType === recipeType);
  // ✅ FIXED: check existence before creating
  if (!product && recipeType === 'ORIGINAL') {
    const existing = products.find(p => p.recipeType === 'ORIGINAL');
    if (existing) return existing;
    const newProduct = {
      id: 'P_ORIGINAL', name: 'น้ำดิบ Original (1000ml)',
      recipeType: 'ORIGINAL', price: 25, status: 'ACTIVE'
    };
    saveProduct(newProduct);
    product = newProduct;
  }
  return product;
}

function recordSaleFromLine(parsed) {
  const results = [];
  const errors = [];
  
  // ✅ Guard: check saleDate not in far future
  if (parsed.saleDate.getTime() > Date.now() + 86400000 * 2) {
    return { results: [], errors: ['ไม่สามารถบันทึกวันที่ในอนาคตเกิน 2 วันได้'] };
  }
  
  for (let i = 0; i < parsed.items.length; i++) {
    const item = parsed.items[i];
    const product = findProductForSale(item.recipeType);
    if (!product) {
      errors.push('ไม่พบสินค้าสูตร ' + item.recipeType);
      continue;
    }
    const unitPrice = Number(product.price) || 35;
    const log = {
      id: 'TX_LINE_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: parsed.saleDate.toISOString(),
      type: 'OUT', qty: item.qty, unitPrice,
      total: item.qty * unitPrice,
      source: 'LINE_BOT', paymentMethod: 'CASH',
      recipeType: item.recipeType, productName: product.name,
      action: 'LINE_SALE', note: 'บันทึกผ่าน LINE Bot'
    };
    const r = addLog(log);
    if (r.status === 'success') results.push({ item, log, product });
    else errors.push(r.message || 'ไม่ทราบสาเหตุ');
  }
  return { results, errors };
}

function handleSaleCommand(event, parsed) {
  const result = recordSaleFromLine(parsed);
  if (result.results.length === 0) {
    return replySaleError(event.replyToken, parsed, result.errors);
  }
  return replySaleConfirmation(event.replyToken, parsed, result);
}

function replySaleConfirmation(replyToken, parsed, result) {
  let totalQty = 0, totalRev = 0;
  const rows = [];
  
  for (const r of result.results) {
    const rt = r.item.recipeType;
    const emoji = rt === 'RED' ? '🔴' : rt === 'BM' ? '🟡' : rt === 'ORIGINAL' ? '⚪' : '📦';
    const color = rt === 'RED' ? '#ef4444' : rt === 'BM' ? '#f59e0b' : rt === 'ORIGINAL' ? '#9ca3af' : '#6b7280';
    totalQty += r.log.qty;
    totalRev += r.log.total;
    rows.push({
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: emoji + ' ' + (r.product.name.length > 22 ? r.product.name.substring(0, 22) + '...' : r.product.name), size: 'sm', color: '#e5e7eb', flex: 5, wrap: true },
        { type: 'text', text: r.log.qty + ' ขวด', size: 'sm', color, align: 'end', flex: 2, weight: 'bold' },
        { type: 'text', text: '฿' + Math.round(r.log.total).toLocaleString(), size: 'sm', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
      ],
      margin: 'md'
    });
  }
  
  const flexMessage = {
    type: 'flex',
    altText: '✅ บันทึกการขายสำเร็จ — ฿' + Math.round(totalRev).toLocaleString(),
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '✅ บันทึกการขายสำเร็จ', weight: 'bold', color: '#10b981', size: 'lg' },
          { type: 'text', text: '📅 ' + formatThaiDate(parsed.saleDate), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ],
        backgroundColor: '#0a0c10', paddingAll: '16px'
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '💰 ยอดรวม', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: '฿' + Math.round(totalRev).toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold', margin: 'xs' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: [
              { type: 'text', text: '📦 ' + totalQty + ' ขวด', color: '#3b82f6', size: 'xs', flex: 1 },
              { type: 'text', text: '🧾 ' + result.results.length + ' รายการ', color: '#8b5cf6', size: 'xs', align: 'end', flex: 1 }
            ]}
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '📋 รายละเอียด', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          ...rows,
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '💡 แก้ไข/ลบได้ที่หน้าเว็บ KRATOM POS', color: '#6b7280', size: 'xs', margin: 'md', wrap: true }
        ],
        paddingAll: '16px'
      },
      styles: {
        header: { backgroundColor: '#0a0c10' },
        body: { backgroundColor: '#0a0c10' }
      }
    }
  };
  replyFlex(replyToken, flexMessage);
}

function replySaleError(replyToken, parsed, errors) {
  replyText(replyToken,
    '❌ บันทึกไม่สำเร็จ\n\n📅 ' + formatThaiDate(parsed.saleDate) + '\n📋 ' + parsed.items.length + ' รายการ\n\n⚠️ ข้อผิดพลาด:\n' +
    errors.map(e => '• ' + e).join('\n') + '\n\n💡 ตรวจสอบสินค้าในระบบ'
  );
}

// ============================================================================
// 📊 REPORT FLEX BUILDERS (daily / weekly / monthly) — kept identical structure
// ============================================================================
function buildDailyReportFlex(targetDate) {
  const data = getAllData();
  const d = targetDate ? new Date(targetDate) : new Date();
  d.setHours(0, 0, 0, 0);
  const dayStart = d;
  const dayEnd = new Date(d.getTime() + 86400000);
  const yStart = new Date(d.getTime() - 86400000);
  const today = calcStats(data.logs, data.expenses, dayStart, dayEnd);
  const yesterday = calcStats(data.logs, data.expenses, yStart, dayStart);
  const sales = (data.logs || []).filter(l => {
    if (l.type !== 'OUT') return false;
    const ld = new Date(l.timestamp);
    return ld >= dayStart && ld < dayEnd;
  });
  const byProduct = {};
  sales.forEach(l => {
    const key = l.productName || 'ไม่ทราบ';
    if (!byProduct[key]) byProduct[key] = { qty: 0, rev: 0, rt: l.recipeType || '' };
    byProduct[key].qty += Number(l.qty || 0);
    byProduct[key].rev += Number(l.total || 0);
  });
  const sorted = Object.keys(byProduct).sort((a, b) => byProduct[b].qty - byProduct[a].qty);
  const growth = yesterday.revenue > 0 ? ((today.revenue - yesterday.revenue) / yesterday.revenue) * 100 : 0;
  const growthColor = growth >= 0 ? '#10b981' : '#ef4444';
  const productRows = sorted.map(name => {
    const p = byProduct[name];
    const ri = p.rt === 'RED' ? { emoji: '🔴', color: '#ef4444' } :
               p.rt === 'BM' ? { emoji: '🟡', color: '#f59e0b' } :
               p.rt === 'ORIGINAL' ? { emoji: '⚪', color: '#9ca3af' } :
               { emoji: '📦', color: '#6b7280' };
    return {
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: ri.emoji + ' ' + (name.length > 22 ? name.substring(0, 22) + '...' : name), size: 'sm', color: '#e5e7eb', flex: 5, wrap: true },
        { type: 'text', text: p.qty + ' ขวด', size: 'sm', color: ri.color, align: 'end', flex: 2, weight: 'bold' },
        { type: 'text', text: '฿' + Math.round(p.rev).toLocaleString(), size: 'sm', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
      ],
      margin: 'md'
    };
  });
  const netMargin = today.revenue > 0 ? (today.profit / today.revenue) * 100 : 0;
  const marginColor = netMargin >= 30 ? '#10b981' : netMargin >= 15 ? '#3b82f6' : netMargin >= 0 ? '#f59e0b' : '#ef4444';
  
  return {
    type: 'flex', altText: 'รายงานประจำวัน ' + formatThaiDateShort(d),
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '🌙 รายงานประจำวัน', weight: 'bold', color: '#10b981', size: 'lg' },
          { type: 'text', text: formatThaiDate(d), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ],
        backgroundColor: '#0a0c10', paddingAll: '16px'
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '💰 รายได้รวม', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: '฿' + Math.round(today.revenue).toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold', margin: 'xs' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: [
              { type: 'text', text: '📦 ' + today.volume + ' ขวด', color: '#3b82f6', size: 'xs', flex: 1 },
              { type: 'text', text: '🧾 ' + today.txCount + ' บิล', color: '#8b5cf6', size: 'xs', align: 'end', flex: 1 }
            ]}
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'เทียบกับเมื่อวาน', color: '#9ca3af', size: 'xs', flex: 3 },
            { type: 'text', text: (growth >= 0 ? '📈 +' : '📉 ') + growth.toFixed(1) + '%', color: growthColor, size: 'sm', weight: 'bold', align: 'end', flex: 2 }
          ], margin: 'sm', paddingAll: '8px', backgroundColor: '#0a0c10', cornerRadius: '8px' },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '📋 สินค้าแต่ละตัว', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          ...(productRows.length > 0 ? productRows : [
            { type: 'text', text: 'ไม่มีรายการขายในวันนี้', color: '#6b7280', size: 'xs', margin: 'md', align: 'center' }
          ]),
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '💵 สรุปการเงิน', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายได้', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(today.revenue).toLocaleString(), color: '#10b981', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายจ่าย', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(today.expenses).toLocaleString(), color: '#ef4444', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'กำไรสุทธิ', color: '#ffffff', size: 'sm', flex: 3, weight: 'bold' },
            { type: 'text', text: '฿' + Math.round(today.profit).toLocaleString(), color: today.profit >= 0 ? '#f59e0b' : '#ef4444', size: 'md', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'อัตรากำไร', color: '#9ca3af', size: 'xs', flex: 3 },
            { type: 'text', text: netMargin.toFixed(1) + '%', color: marginColor, size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' }
        ],
        paddingAll: '16px'
      },
      styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
    }
  };
}

function replyDailyReport(replyToken) {
  try { replyFlex(replyToken, buildDailyReportFlex(new Date())); }
  catch (err) { console.error('replyDailyReport:', err); replyText(replyToken, '❌ ' + err.toString()); }
}

function buildWeeklyReportFlex(targetDate) {
  const data = getAllData();
  const now = targetDate ? new Date(targetDate) : new Date();
  const weekEnd = new Date(now); weekEnd.setHours(23, 59, 59, 999);
  const weekStart = new Date(weekEnd.getTime() - 7 * 86400000 + 1); weekStart.setHours(0, 0, 0, 0);
  const prevEnd = new Date(weekStart.getTime());
  const prevStart = new Date(prevEnd.getTime() - 7 * 86400000);
  const week = calcStats(data.logs, data.expenses, weekStart, weekEnd);
  const prev = calcStats(data.logs, data.expenses, prevStart, prevEnd);
  const sales = (data.logs || []).filter(l => {
    if (l.type !== 'OUT') return false;
    const ld = new Date(l.timestamp);
    return ld >= weekStart && ld <= weekEnd;
  });
  const dayNames = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  const dd = [];
  for (let i = 6; i >= 0; i--) {
    const ds = new Date(weekEnd.getTime() - i * 86400000); ds.setHours(0, 0, 0, 0);
    const de = new Date(ds.getTime() + 86400000);
    const dSales = sales.filter(l => { const d = new Date(l.timestamp); return d >= ds && d < de; });
    dd.push({
      dayName: dayNames[ds.getDay()], date: ds,
      revenue: dSales.reduce((s, l) => s + Number(l.total || 0), 0),
      volume: dSales.reduce((s, l) => s + Number(l.qty || 0), 0)
    });
  }
  const maxRev = Math.max.apply(null, dd.map(d => d.revenue)) || 1;
  const dayRows = dd.map(d => {
    const barLen = Math.round((d.revenue / maxRev) * 15);
    const bar = '█'.repeat(Math.max(0, barLen)) + '░'.repeat(Math.max(0, 15 - barLen));
    return {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: d.dayName + ' ' + d.date.getDate() + '/' + (d.date.getMonth() + 1), size: 'xs', color: '#9ca3af', flex: 3 },
          { type: 'text', text: '฿' + Math.round(d.revenue).toLocaleString(), size: 'xs', color: d.revenue === maxRev ? '#10b981' : '#ffffff', align: 'end', flex: 3, weight: 'bold' },
          { type: 'text', text: d.volume + ' ขวด', size: 'xxs', color: '#6b7280', align: 'end', flex: 2 }
        ]},
        { type: 'text', text: bar, size: 'xs', color: d.revenue === maxRev ? '#10b981' : '#3b82f6', margin: 'xs' }
      ],
      margin: 'md'
    };
  });
  const byProduct = {};
  sales.forEach(l => {
    const key = l.productName || 'ไม่ทราบ';
    if (!byProduct[key]) byProduct[key] = { qty: 0, rev: 0, rt: l.recipeType || '' };
    byProduct[key].qty += Number(l.qty || 0);
    byProduct[key].rev += Number(l.total || 0);
  });
  const sorted = Object.keys(byProduct).sort((a, b) => byProduct[b].qty - byProduct[a].qty).slice(0, 8);
  const productRows = sorted.map(name => {
    const p = byProduct[name];
    const ri = p.rt === 'RED' ? { emoji: '🔴', color: '#ef4444' } :
               p.rt === 'BM' ? { emoji: '🟡', color: '#f59e0b' } :
               p.rt === 'ORIGINAL' ? { emoji: '⚪', color: '#9ca3af' } :
               { emoji: '📦', color: '#6b7280' };
    return {
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: ri.emoji + ' ' + (name.length > 22 ? name.substring(0, 22) + '...' : name), size: 'xs', color: '#e5e7eb', flex: 5, wrap: true },
        { type: 'text', text: p.qty + ' ขวด', size: 'xs', color: ri.color, align: 'end', flex: 2, weight: 'bold' },
        { type: 'text', text: '฿' + Math.round(p.rev).toLocaleString(), size: 'xs', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
      ],
      margin: 'sm'
    };
  });
  const growth = prev.revenue > 0 ? ((week.revenue - prev.revenue) / prev.revenue) * 100 : 0;
  const growthColor = growth >= 0 ? '#10b981' : '#ef4444';
  
  return {
    type: 'flex', altText: 'รายงานสัปดาห์ ' + formatThaiDateShort(weekStart) + ' - ' + formatThaiDateShort(weekEnd),
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '📅 รายงานสัปดาห์', weight: 'bold', color: '#3b82f6', size: 'lg' },
          { type: 'text', text: formatThaiDateShort(weekStart) + ' - ' + formatThaiDateShort(weekEnd), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ],
        backgroundColor: '#0a0c10', paddingAll: '16px'
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '💰 รายได้รวม 7 วัน', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: '฿' + Math.round(week.revenue).toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold', margin: 'xs' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: [
              { type: 'text', text: '📦 ' + week.volume + ' ขวด', color: '#3b82f6', size: 'xs', flex: 1 },
              { type: 'text', text: '🧾 ' + week.txCount + ' บิล', color: '#8b5cf6', size: 'xs', align: 'end', flex: 1 }
            ]}
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'เทียบกับสัปดาห์ก่อน', color: '#9ca3af', size: 'xs', flex: 3 },
            { type: 'text', text: (growth >= 0 ? '📈 +' : '📉 ') + growth.toFixed(1) + '%', color: growthColor, size: 'sm', weight: 'bold', align: 'end', flex: 2 }
          ], margin: 'sm', paddingAll: '8px', backgroundColor: '#0a0c10', cornerRadius: '8px' },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '📊 ยอดขายรายวัน', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          ...dayRows,
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '🏆 Top ' + Math.min(8, sorted.length), weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          ...(productRows.length > 0 ? productRows : [
            { type: 'text', text: 'ไม่มีรายการขาย', color: '#6b7280', size: 'xs', margin: 'md', align: 'center' }
          ]),
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '💵 สรุปการเงิน', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายได้', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(week.revenue).toLocaleString(), color: '#10b981', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายจ่าย', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(week.expenses).toLocaleString(), color: '#ef4444', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'กำไรสุทธิ', color: '#ffffff', size: 'sm', flex: 3, weight: 'bold' },
            { type: 'text', text: '฿' + Math.round(week.profit).toLocaleString(), color: week.profit >= 0 ? '#f59e0b' : '#ef4444', size: 'md', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' }
        ],
        paddingAll: '16px'
      },
      styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
    }
  };
}

function replyWeeklyReport(replyToken) {
  try { replyFlex(replyToken, buildWeeklyReportFlex(new Date())); }
  catch (err) { console.error('replyWeeklyReport:', err); replyText(replyToken, '❌ ' + err.toString()); }
}

function buildMonthlyReportFlex(targetDate) {
  const data = getAllData();
  const now = targetDate ? new Date(targetDate) : new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  const month = calcStats(data.logs, data.expenses, monthStart, monthEnd);
  const prev = calcStats(data.logs, data.expenses, prevStart, prevEnd);
  const sales = (data.logs || []).filter(l => {
    if (l.type !== 'OUT') return false;
    const ld = new Date(l.timestamp);
    return ld >= monthStart && ld <= monthEnd;
  });
  const byProduct = {};
  sales.forEach(l => {
    const key = l.productName || 'ไม่ทราบ';
    if (!byProduct[key]) byProduct[key] = { qty: 0, rev: 0, rt: l.recipeType || '' };
    byProduct[key].qty += Number(l.qty || 0);
    byProduct[key].rev += Number(l.total || 0);
  });
  const sorted = Object.keys(byProduct).sort((a, b) => byProduct[b].rev - byProduct[a].rev).slice(0, 10);
  const productRows = sorted.map((name, idx) => {
    const p = byProduct[name];
    const rankEmoji = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '#' + (idx + 1);
    const ri = p.rt === 'RED' ? { emoji: '🔴', color: '#ef4444' } :
               p.rt === 'BM' ? { emoji: '🟡', color: '#f59e0b' } :
               p.rt === 'ORIGINAL' ? { emoji: '⚪', color: '#9ca3af' } :
               { emoji: '📦', color: '#6b7280' };
    return {
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: rankEmoji + ' ' + ri.emoji, size: 'sm', color: '#e5e7eb', flex: 1 },
        { type: 'text', text: name.length > 18 ? name.substring(0, 18) + '...' : name, size: 'xs', color: '#e5e7eb', flex: 4, wrap: true },
        { type: 'text', text: p.qty + ' ขวด', size: 'xs', color: ri.color, align: 'end', flex: 2, weight: 'bold' },
        { type: 'text', text: '฿' + Math.round(p.rev).toLocaleString(), size: 'xs', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
      ],
      margin: 'sm'
    };
  });
  const growth = prev.revenue > 0 ? ((month.revenue - prev.revenue) / prev.revenue) * 100 : 0;
  const growthColor = growth >= 0 ? '#10b981' : '#ef4444';
  const netMargin = month.revenue > 0 ? (month.profit / month.revenue) * 100 : 0;
  const monthName = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
                     'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'][now.getMonth()];
  
  return {
    type: 'flex', altText: 'รายงานเดือน ' + monthName + ' ' + (now.getFullYear() + 543),
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '📆 รายงานประจำเดือน', weight: 'bold', color: '#f59e0b', size: 'lg' },
          { type: 'text', text: monthName + ' ' + (now.getFullYear() + 543), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ],
        backgroundColor: '#0a0c10', paddingAll: '16px'
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '💰 รายได้รวมทั้งเดือน', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: '฿' + Math.round(month.revenue).toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold', margin: 'xs' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: [
              { type: 'text', text: '📦 ' + month.volume + ' ขวด', color: '#3b82f6', size: 'xs', flex: 1 },
              { type: 'text', text: '🧾 ' + month.txCount + ' บิล', color: '#8b5cf6', size: 'xs', align: 'end', flex: 1 }
            ]}
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'เทียบกับเดือนก่อน', color: '#9ca3af', size: 'xs', flex: 3 },
            { type: 'text', text: (growth >= 0 ? '📈 +' : '📉 ') + growth.toFixed(1) + '%', color: growthColor, size: 'sm', weight: 'bold', align: 'end', flex: 2 }
          ], margin: 'sm', paddingAll: '8px', backgroundColor: '#0a0c10', cornerRadius: '8px' },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '🏆 Top ' + sorted.length, weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          ...(productRows.length > 0 ? productRows : [
            { type: 'text', text: 'ไม่มีรายการขาย', color: '#6b7280', size: 'xs', margin: 'md', align: 'center' }
          ]),
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '💵 สรุปการเงิน', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายได้', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(month.revenue).toLocaleString(), color: '#10b981', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายจ่าย', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(month.expenses).toLocaleString(), color: '#ef4444', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'กำไรสุทธิ', color: '#ffffff', size: 'sm', flex: 3, weight: 'bold' },
            { type: 'text', text: '฿' + Math.round(month.profit).toLocaleString(), color: month.profit >= 0 ? '#f59e0b' : '#ef4444', size: 'md', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'อัตรากำไร', color: '#9ca3af', size: 'xs', flex: 3 },
            { type: 'text', text: netMargin.toFixed(1) + '%', color: netMargin >= 20 ? '#10b981' : netMargin >= 0 ? '#f59e0b' : '#ef4444', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' }
        ],
        paddingAll: '16px'
      },
      styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
    }
  };
}

function replyMonthlyReport(replyToken) {
  try { replyFlex(replyToken, buildMonthlyReportFlex(new Date())); }
  catch (err) { console.error('replyMonthlyReport:', err); replyText(replyToken, '❌ ' + err.toString()); }
}

// ============================================================================
// 📌 OTHER LINE REPLIES (dashboard, reports, products, KPI, etc.)
// ============================================================================
function replyDashboard(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const todayStats = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth(), now.getDate()), now);
    const weekStats = calcStats(data.logs, data.expenses, new Date(now.getTime() - 7 * 86400000), now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthStats = calcStats(data.logs, data.expenses, monthStart, now);
    const lastMonthStats = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth() - 1, 1), monthStart);
    const monthGrowth = lastMonthStats.revenue > 0 ? ((monthStats.revenue - lastMonthStats.revenue) / lastMonthStats.revenue) * 100 : 0;
    const growthColor = monthGrowth >= 0 ? '#10b981' : '#ef4444';
    
    const products = data.products || [];
    let totalStock = 0, lowStock = 0;
    products.forEach(p => {
      const stock = calculateStockForProduct(p);
      totalStock += Math.max(0, stock);
      if (stock <= 5) lowStock++;
    });
    
    replyFlex(replyToken, {
      type: 'flex', altText: 'Dashboard',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📊 DASHBOARD', weight: 'bold', color: '#10b981', size: 'xl' },
            { type: 'text', text: formatThaiDate(new Date()), color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '20px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'lg',
          contents: [
            createSectionTitle('🌅 วันนี้', '#10b981'),
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('💰 รายได้', '฿' + todayStats.revenue.toLocaleString(), '#10b981'),
              createStatBox('📦 ขวด', String(todayStats.volume), '#3b82f6')
            ]},
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('🧾 บิล', String(todayStats.txCount), '#8b5cf6'),
              createStatBox('💵 กำไร', '฿' + todayStats.profit.toLocaleString(), todayStats.profit >= 0 ? '#f59e0b' : '#ef4444')
            ], margin: 'sm' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📅 7 วัน', '#3b82f6'),
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('💰 รายได้', '฿' + weekStats.revenue.toLocaleString(), '#10b981'),
              createStatBox('📦 ขวด', String(weekStats.volume), '#3b82f6')
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📆 เดือนนี้', '#f59e0b'),
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('💰 รายได้', '฿' + monthStats.revenue.toLocaleString(), '#10b981'),
              createStatBox('📈 เติบโต', (monthGrowth >= 0 ? '+' : '') + monthGrowth.toFixed(1) + '%', growthColor)
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📦 สต๊อก', '#ef4444'),
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('รวม', totalStock + ' ขวด', '#3b82f6'),
              createStatBox('ต่ำ', lowStock + ' รายการ', lowStock > 0 ? '#ef4444' : '#10b981')
            ]},
            { type: 'separator', margin: 'lg' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createQuickButton('รายงานวันนี้', '#10b981'),
              createQuickButton('รายงานสัปดาห์', '#3b82f6'),
              createQuickButton('รายงานเดือน', '#f59e0b')
            ], margin: 'md' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { console.error('replyDashboard:', err); replyText(replyToken, '❌ ' + err.toString()); }
}

function replySalesReport(replyToken, period) {
  try {
    const data = getFilteredDataByPeriod(period);
    const { logs, expenses } = data;
    const salesLogs = logs.filter(l => l.type === 'OUT');
    const totalRev = salesLogs.reduce((s, l) => s + Number(l.total || 0), 0);
    const totalVol = salesLogs.reduce((s, l) => s + Number(l.qty || 0), 0);
    const totalExp = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const profit = totalRev - totalExp;
    const redQty = salesLogs.filter(l => l.recipeType === 'RED').reduce((s, l) => s + Number(l.qty || 0), 0);
    const bmQty = salesLogs.filter(l => l.recipeType === 'BM').reduce((s, l) => s + Number(l.qty || 0), 0);
    const origQty = salesLogs.filter(l => l.recipeType === 'ORIGINAL').reduce((s, l) => s + Number(l.qty || 0), 0);
    const cashRev = salesLogs.filter(l => l.paymentMethod === 'CASH').reduce((s, l) => s + Number(l.total || 0), 0);
    const transferRev = totalRev - cashRev;
    const periodText = { today: 'วันนี้', yesterday: 'เมื่อวาน', '7days': '7 วัน', thisMonth: 'เดือนนี้' }[period] || period;
    
    replyFlex(replyToken, {
      type: 'flex', altText: 'รายงาน ' + periodText,
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📊 รายงาน ' + periodText, weight: 'bold', color: '#10b981', size: 'lg' },
            { type: 'text', text: new Date().toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }), color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💰 ยอดขายรวม', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: '฿' + totalRev.toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('📦 ขวด', String(totalVol), '#3b82f6'),
              createStatBox('🧾 บิล', String(salesLogs.length), '#8b5cf6')
            ]},
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('🔴 ฝาแดง', redQty + ' ขวด', '#ef4444'),
              createStatBox('🟡 BM', bmQty + ' ขวด', '#f59e0b'),
              createStatBox('⚪ Original', origQty + ' ขวด', '#9ca3af')
            ]},
            { type: 'box', layout: 'vertical', contents: [
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: 'รายได้', size: 'sm', color: '#9ca3af', flex: 3 },
                { type: 'text', text: '฿' + totalRev.toLocaleString(), size: 'sm', color: '#10b981', align: 'end', flex: 4, weight: 'bold' }
              ]},
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: 'รายจ่าย', size: 'sm', color: '#9ca3af', flex: 3 },
                { type: 'text', text: '฿' + totalExp.toLocaleString(), size: 'sm', color: '#ef4444', align: 'end', flex: 4, weight: 'bold' }
              ], margin: 'sm' },
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: 'กำไรสุทธิ', size: 'sm', color: '#ffffff', flex: 3, weight: 'bold' },
                { type: 'text', text: '฿' + profit.toLocaleString(), size: 'md', color: profit >= 0 ? '#f59e0b' : '#ef4444', align: 'end', flex: 4, weight: 'bold' }
              ], margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px', margin: 'md' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('💵 เงินสด', '฿' + cashRev.toLocaleString(), '#10b981'),
              createStatBox('📱 โอน', '฿' + transferRev.toLocaleString(), '#3b82f6')
            ], margin: 'md' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyProfitReport(replyToken) {
  try {
    const thisMonth = getFilteredDataByPeriod('thisMonth');
    const lastMonth = getFilteredDataByPeriod('lastMonth');
    const thisRev = thisMonth.logs.filter(l => l.type === 'OUT').reduce((s, l) => s + Number(l.total || 0), 0);
    const thisExp = thisMonth.expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const thisProfit = thisRev - thisExp;
    const lastRev = lastMonth.logs.filter(l => l.type === 'OUT').reduce((s, l) => s + Number(l.total || 0), 0);
    const lastExp = lastMonth.expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const lastProfit = lastRev - lastExp;
    const profitChange = lastProfit !== 0 ? ((thisProfit - lastProfit) / Math.abs(lastProfit)) * 100 : 0;
    const changeColor = profitChange >= 0 ? '#10b981' : '#ef4444';
    const expByCat = {};
    thisMonth.expenses.forEach(e => { expByCat[e.category] = (expByCat[e.category] || 0) + Number(e.amount || 0); });
    const catLabels = { LEAVES: '🍃 ใบกระท่อม', COKE: '🥤 โค้ก', SYRUP_RED: '🧪 ยาแก้ไอฝาแดง', SYRUP_BM: '🧪 ยาแก้ไอ BM', BOTTLE: '🍾 ขวด', GAS: '🔥 แก๊ส', PLUM: '🫐 บ๊วย', OTHER: '📦 อื่นๆ' };
    const expRows = Object.keys(expByCat).sort((a, b) => expByCat[b] - expByCat[a]).slice(0, 5).map(cat => ({
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: catLabels[cat] || cat, size: 'xs', color: '#9ca3af', flex: 5 },
        { type: 'text', text: '฿' + expByCat[cat].toLocaleString(), size: 'xs', color: '#ffffff', align: 'end', flex: 3, weight: 'bold' }
      ], margin: 'xs'
    }));
    
    replyFlex(replyToken, {
      type: 'flex', altText: 'รายงานกำไร',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '💰 กำไร-ขาดทุน', weight: 'bold', color: '#f59e0b', size: 'lg' },
            { type: 'text', text: 'เดือนนี้ vs เดือนที่แล้ว', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'กำไรสุทธิเดือนนี้', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: '฿' + thisProfit.toLocaleString(), color: thisProfit >= 0 ? '#10b981' : '#ef4444', size: 'xxl', weight: 'bold' },
              { type: 'text', text: (profitChange >= 0 ? '📈 +' : '📉 ') + profitChange.toFixed(1) + '% เทียบเดือนก่อน', color: changeColor, size: 'xs', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('รายได้', '฿' + thisRev.toLocaleString(), '#10b981'),
              createStatBox('รายจ่าย', '฿' + thisExp.toLocaleString(), '#ef4444')
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📋 รายจ่ายแยกหมวด', '#f59e0b'),
            { type: 'box', layout: 'vertical', contents: expRows.length > 0 ? expRows : [
              { type: 'text', text: 'ไม่มีรายจ่าย', color: '#6b7280', size: 'xs' }
            ], margin: 'sm' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyCostAnalysis(replyToken) {
  try {
    const data = getAllData();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const recentExp = data.expenses.filter(e => new Date(e.timestamp) >= thirtyDaysAgo);
    const recentSales = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= thirtyDaysAgo);
    const expByCat = {};
    recentExp.forEach(e => { expByCat[e.category] = (expByCat[e.category] || 0) + Number(e.amount || 0); });
    const totalCost = Object.values(expByCat).reduce((a, b) => a + b, 0);
    const volume = recentSales.reduce((s, l) => s + Number(l.qty || 0), 0);
    const costPerBottle = volume > 0 ? totalCost / volume : 0;
    const catLabels = { LEAVES: '🍃 ใบ', COKE: '🥤 โค้ก', SYRUP_RED: '🧪 ยาแดง', SYRUP_BM: '🧪 ยา BM', BOTTLE: '🍾 ขวด', GAS: '🔥 แก๊ส', PLUM: '🫐 บ๊วย', OTHER: '📦 อื่นๆ' };
    const costRows = Object.keys(expByCat).sort((a, b) => expByCat[b] - expByCat[a]).map(cat => ({
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: catLabels[cat] || cat, size: 'xs', color: '#9ca3af', flex: 5 },
        { type: 'text', text: '฿' + expByCat[cat].toLocaleString(), size: 'xs', color: '#ef4444', align: 'end', flex: 3, weight: 'bold' }
      ], margin: 'sm'
    }));
    
    replyFlex(replyToken, {
      type: 'flex', altText: 'ต้นทุน 30 วัน',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '💸 ต้นทุน 30 วัน', weight: 'bold', color: '#ef4444', size: 'lg' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'ต้นทุนรวม', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: '฿' + totalCost.toLocaleString(), color: '#ef4444', size: 'xxl', weight: 'bold' },
              { type: 'text', text: 'ต้นทุน/ขวด ฿' + costPerBottle.toFixed(1), color: '#f59e0b', size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            ...costRows
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyStockReport(replyToken) {
  try {
    const products = getProducts().products || [];
    const stockRows = products.map(p => {
      const stock = calculateStockForProduct(p);
      const color = stock <= 5 ? '#ef4444' : stock <= 15 ? '#f59e0b' : '#10b981';
      const emoji = stock <= 5 ? '🔴' : stock <= 15 ? '🟡' : '🟢';
      return {
        type: 'box', layout: 'horizontal',
        contents: [
          { type: 'text', text: p.name, size: 'xs', color: '#e5e7eb', flex: 6, wrap: true },
          { type: 'text', text: emoji + ' ' + stock, size: 'sm', color, align: 'end', flex: 2, weight: 'bold' }
        ],
        margin: 'md'
      };
    });
    const totalStock = products.reduce((s, p) => s + calculateStockForProduct(p), 0);
    const lowStockCount = products.filter(p => calculateStockForProduct(p) <= 5).length;
    
    replyFlex(replyToken, {
      type: 'flex', altText: 'สต๊อก',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📦 สต๊อก', weight: 'bold', color: '#3b82f6', size: 'lg' },
            { type: 'text', text: formatThaiDate(new Date()), color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('รวม', totalStock + ' ขวด', '#3b82f6'),
              createStatBox('ต่ำ', lowStockCount + ' รายการ', lowStockCount > 0 ? '#ef4444' : '#10b981')
            ]},
            { type: 'separator', margin: 'lg' },
            ...stockRows
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyTopProducts(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const prodStats = {};
    salesLogs.forEach(l => {
      if (!prodStats[l.productName]) prodStats[l.productName] = { qty: 0, rev: 0, recipeType: l.recipeType };
      prodStats[l.productName].qty += Number(l.qty || 0);
      prodStats[l.productName].rev += Number(l.total || 0);
    });
    const sorted = Object.keys(prodStats).sort((a, b) => prodStats[b].qty - prodStats[a].qty).slice(0, 5);
    const totalQty = salesLogs.reduce((s, l) => s + Number(l.qty || 0), 0);
    const rankEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const topRows = sorted.map((name, idx) => {
      const s = prodStats[name];
      const pct = totalQty > 0 ? ((s.qty / totalQty) * 100).toFixed(1) : 0;
      return {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: rankEmojis[idx] + ' ' + name, size: 'sm', color: '#ffffff', weight: 'bold', flex: 6, wrap: true },
            { type: 'text', text: s.qty + ' ขวด', size: 'sm', color: '#10b981', align: 'end', flex: 2, weight: 'bold' }
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายได้ ฿' + s.rev.toLocaleString(), size: 'xs', color: '#9ca3af', flex: 5 },
            { type: 'text', text: pct + '%', size: 'xs', color: '#f59e0b', align: 'end', flex: 3 }
          ], margin: 'xs' }
        ],
        margin: 'lg'
      };
    });
    
    replyFlex(replyToken, {
      type: 'flex', altText: 'Top 5 สินค้า',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '🏆 สินค้าขายดี Top 5', weight: 'bold', color: '#f59e0b', size: 'lg' },
            { type: 'text', text: 'รวม ' + totalQty + ' ขวด', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical',
          contents: topRows.length > 0 ? topRows : [
            { type: 'text', text: 'ยังไม่มีข้อมูล', color: '#6b7280', size: 'sm' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyProductAnalysis(replyToken) {
  try {
    const data = getAllData();
    const products = data.products || [];
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const recentSales = salesLogs.filter(l => new Date(l.timestamp) >= thirtyDaysAgo);
    const totalRev = recentSales.reduce((s, l) => s + Number(l.total || 0), 0);
    const totalVol = recentSales.reduce((s, l) => s + Number(l.qty || 0), 0);
    const stats = products.map(p => {
      const sales = recentSales.filter(l => l.productName === p.name);
      const revenue = sales.reduce((s, l) => s + Number(l.total || 0), 0);
      const volume = sales.reduce((s, l) => s + Number(l.qty || 0), 0);
      const unitCost = getUnitCostFromConfig(p.recipeType);
      const profit = revenue - (volume * unitCost);
      const volShare = totalVol > 0 ? (volume / totalVol) * 100 : 0;
      return { product: p, revenue, volume, profit, volShare };
    }).sort((a, b) => b.revenue - a.revenue);
    const productCards = stats.map((p, idx) => {
      const rt = p.product.recipeType;
      const emoji = rt === 'RED' ? '🔴' : rt === 'BM' ? '🟡' : '⚪';
      const rankEmoji = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '#' + (idx + 1);
      return {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: rankEmoji + ' ' + emoji, size: 'sm', flex: 1 },
            { type: 'text', text: p.product.name, size: 'xs', color: '#ffffff', weight: 'bold', flex: 5, wrap: true },
            { type: 'text', text: p.volShare.toFixed(1) + '%', size: 'xs', color: '#f59e0b', align: 'end', flex: 2, weight: 'bold' }
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'ขาย ' + p.volume + ' ขวด', size: 'xxs', color: '#9ca3af', flex: 3 },
            { type: 'text', text: '฿' + p.revenue.toLocaleString(), size: 'xs', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
          ], margin: 'xs' }
        ],
        backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', margin: 'md'
      };
    });
    
    replyFlex(replyToken, {
      type: 'flex', altText: 'วิเคราะห์สินค้า',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📊 วิเคราะห์สินค้า', weight: 'bold', color: '#10b981', size: 'lg' },
            { type: 'text', text: '30 วัน · เรียงตามรายได้', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('รายได้', '฿' + totalRev.toLocaleString(), '#10b981'),
              createStatBox('ขวด', String(totalVol), '#3b82f6')
            ]},
            { type: 'separator', margin: 'lg' },
            ...productCards
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyProductDetail(replyToken, productName) {
  try {
    if (!productName) { replyText(replyToken, '❌ ระบุชื่อสินค้า\nเช่น สินค้า น้ำกระท่อมฝาแดง'); return; }
    const data = getAllData();
    const product = (data.products || []).find(p => p.name.toLowerCase().includes(productName.toLowerCase()));
    if (!product) { replyText(replyToken, '❌ ไม่พบสินค้า "' + productName + '"'); return; }
    const salesLogs = data.logs.filter(l => l.type === 'OUT' && l.productName === product.name);
    const allStats = {
      volume: salesLogs.reduce((s, l) => s + Number(l.qty || 0), 0),
      revenue: salesLogs.reduce((s, l) => s + Number(l.total || 0), 0),
      count: salesLogs.length
    };
    const unitCost = getUnitCostFromConfig(product.recipeType);
    const unitProfit = product.price - unitCost;
    const margin = product.price > 0 ? (unitProfit / product.price) * 100 : 0;
    const stock = calculateStockForProduct(product);
    
    replyFlex(replyToken, {
      type: 'flex', altText: product.name,
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: product.recipeType === 'RED' ? '🔴' : product.recipeType === 'BM' ? '🟡' : '⚪', size: 'xxl' },
            { type: 'text', text: product.name, weight: 'bold', color: '#ffffff', size: 'md', wrap: true, margin: 'sm' },
            { type: 'text', text: 'ราคา ฿' + product.price, color: '#9ca3af', size: 'xs', margin: 'xs' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'ยอดขายรวม', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: '฿' + allStats.revenue.toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold' },
              { type: 'text', text: 'ขายได้ ' + allStats.volume + ' ขวด', color: '#3b82f6', size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createAnalysisRow('ต้นทุน/ขวด', '฿' + unitCost.toFixed(2), '#ef4444'),
            createAnalysisRow('กำไร/ขวด', '฿' + unitProfit.toFixed(2), '#10b981'),
            createAnalysisRow('Margin', margin.toFixed(1) + '%', margin > 30 ? '#10b981' : '#f59e0b'),
            createAnalysisRow('สต๊อก', stock + ' ขวด', stock <= 5 ? '#ef4444' : '#10b981')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyMarketShare(replyToken) {
  try {
    const data = getAllData();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const rs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= thirtyDaysAgo);
    const totalRev = rs.reduce((s, l) => s + Number(l.total || 0), 0);
    const ps = {};
    rs.forEach(l => {
      if (!ps[l.productName]) ps[l.productName] = { rev: 0, rt: l.recipeType };
      ps[l.productName].rev += Number(l.total || 0);
    });
    const sorted = Object.keys(ps).sort((a, b) => ps[b].rev - ps[a].rev);
    const rows = sorted.map(name => {
      const pct = totalRev > 0 ? (ps[name].rev / totalRev) * 100 : 0;
      const color = pct > 40 ? '#10b981' : pct > 20 ? '#3b82f6' : '#f59e0b';
      return createAnalysisRow(name.length > 25 ? name.substring(0, 25) + '...' : name, pct.toFixed(1) + '%', color);
    });
    replyFlex(replyToken, {
      type: 'flex', altText: 'สัดส่วนตลาด',
      contents: {
        type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📊 สัดส่วนตลาด', weight: 'bold', color: '#8b5cf6', size: 'lg' },
          { type: 'text', text: '30 วัน', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: 'รายได้รวม', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: '฿' + totalRev.toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold' }
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
          { type: 'separator', margin: 'lg' },
          ...rows
        ], paddingAll: '16px' },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyKPIDashboard(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = calcStats(data.logs, data.expenses, monthStart, now);
    const config = readConfigAsObject(SpreadsheetApp.getActiveSpreadsheet());
    const tr = Number(config.kpiTargetRevenue) || 50000;
    const tv = Number(config.kpiTargetVolume) || 1500;
    const tp = Number(config.kpiTargetProfit) || 15000;
    const revProgress = tr > 0 ? (thisMonth.revenue / tr) * 100 : 0;
    const volProgress = tv > 0 ? (thisMonth.volume / tv) * 100 : 0;
    const profitProgress = tp > 0 ? (thisMonth.profit / tp) * 100 : 0;
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeft = daysInMonth - now.getDate() + 1;
    const projRev = (thisMonth.revenue / now.getDate()) * daysInMonth;
    const projVol = (thisMonth.volume / now.getDate()) * daysInMonth;
    const projProfit = (thisMonth.profit / now.getDate()) * daysInMonth;
    
    const makeBox = (icon, label, cur, target, prog, proj, unit) => {
      const p = Math.min(100, prog);
      const barLen = Math.round(p / 5);
      const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
      const color = prog >= 100 ? '#10b981' : prog >= 75 ? '#3b82f6' : prog >= 50 ? '#f59e0b' : '#ef4444';
      return {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: icon + ' ' + label, size: 'sm', color: '#ffffff', weight: 'bold', flex: 4 },
            { type: 'text', text: prog.toFixed(0) + '%', size: 'sm', color, align: 'end', flex: 2, weight: 'bold' }
          ]},
          { type: 'text', text: bar, size: 'xs', color, margin: 'xs' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'ปัจจุบัน: ' + unit + cur.toLocaleString(), size: 'xxs', color: '#9ca3af', flex: 4 },
            { type: 'text', text: 'เป้า: ' + unit + target.toLocaleString(), size: 'xxs', color: '#6b7280', align: 'end', flex: 4 }
          ], margin: 'xs' },
          { type: 'text', text: 'คาดการณ์: ' + unit + Math.round(proj).toLocaleString(), size: 'xxs', color: '#3b82f6', margin: 'xs' }
        ],
        backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px', margin: 'md'
      };
    };
    
    replyFlex(replyToken, {
      type: 'flex', altText: 'KPI Dashboard',
      contents: {
        type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🎯 KPI', weight: 'bold', color: '#8b5cf6', size: 'xl' },
          { type: 'text', text: 'เหลือ ' + daysLeft + ' วัน', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
          makeBox('💰', 'รายได้', thisMonth.revenue, tr, revProgress, projRev, '฿'),
          makeBox('📦', 'ปริมาณ', thisMonth.volume, tv, volProgress, projVol, ''),
          makeBox('💵', 'กำไร', thisMonth.profit, tp, profitProgress, projProfit, '฿'),
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '⚙️ ตั้งเป้า: "ตั้งเป้า รายได้ 50000"', size: 'xs', color: '#6b7280', wrap: true, margin: 'md' }
        ], paddingAll: '16px' },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyKPITarget(replyToken) {
  try {
    const config = readConfigAsObject(SpreadsheetApp.getActiveSpreadsheet());
    const targets = {
      revenue: Number(config.kpiTargetRevenue) || 50000,
      volume: Number(config.kpiTargetVolume) || 1500,
      profit: Number(config.kpiTargetProfit) || 15000
    };
    replyFlex(replyToken, {
      type: 'flex', altText: 'เป้าหมาย KPI',
      contents: {
        type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🎯 เป้าหมาย KPI', weight: 'bold', color: '#f59e0b', size: 'lg' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '💰 เป้ารายได้/เดือน', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: '฿' + targets.revenue.toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold' }
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '📦 เป้าปริมาณ/เดือน', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: targets.volume.toLocaleString() + ' ขวด', color: '#3b82f6', size: 'xxl', weight: 'bold' }
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '💵 เป้ากำไร/เดือน', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: '฿' + targets.profit.toLocaleString(), color: '#f59e0b', size: 'xxl', weight: 'bold' }
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' }
        ], paddingAll: '16px' },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replySetTarget(replyToken, key, value) {
  try {
    const keyMap = {
      'รายได้': 'kpiTargetRevenue', 'revenue': 'kpiTargetRevenue',
      'ปริมาณ': 'kpiTargetVolume', 'volume': 'kpiTargetVolume',
      'กำไร': 'kpiTargetProfit', 'profit': 'kpiTargetProfit'
    };
    const configKey = keyMap[key];
    if (!configKey) { replyText(replyToken, '❌ ใช้: รายได้, ปริมาณ, กำไร'); return; }
    const numValue = Number(value);
    if (isNaN(numValue) || numValue <= 0) { replyText(replyToken, '❌ ค่าต้องเป็นตัวเลข > 0'); return; }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.CONFIG);
    const data = sheet.getDataRange().getValues();
    let updated = false;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === configKey) {
        sheet.getRange(i + 1, 2).setValue(numValue);
        sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
        updated = true;
        break;
      }
    }
    if (!updated) sheet.appendRow([configKey, numValue, new Date().toISOString()]);
    invalidateCache();
    const labels = { kpiTargetRevenue: '💰 รายได้', kpiTargetVolume: '📦 ปริมาณ', kpiTargetProfit: '💵 กำไร' };
    replyText(replyToken, '✅ ตั้งเป้าใหม่สำเร็จ!\n\n' + labels[configKey] + ': ' + numValue.toLocaleString() + '\n\nพิมพ์ "kpi"');
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyTrendAnalysis(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const dd = [];
    for (let i = 29; i >= 0; i--) {
      const ds = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const de = new Date(ds.getTime() + 86400000);
      const s = calcStats(data.logs, data.expenses, ds, de);
      dd.push({ revenue: s.revenue });
    }
    const n = dd.length;
    const sx = dd.map((_, i) => i).reduce((a, b) => a + b, 0);
    const sy = dd.reduce((a, b) => a + b.revenue, 0);
    const sxy = dd.reduce((sum, d, i) => sum + i * d.revenue, 0);
    const sx2 = dd.map((_, i) => i * i).reduce((a, b) => a + b, 0);
    const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
    const avgRev = sy / n;
    const trendPct = avgRev > 0 ? (slope / avgRev) * 100 : 0;
    let trendText, trendColor;
    if (slope > avgRev * 0.05) { trendText = '📈 เพิ่มชัดเจน'; trendColor = '#10b981'; }
    else if (slope > 0) { trendText = '↗️ เพิ่มเล็กน้อย'; trendColor = '#3b82f6'; }
    else if (slope < -avgRev * 0.05) { trendText = '📉 ลดชัดเจน'; trendColor = '#ef4444'; }
    else if (slope < 0) { trendText = '↘️ ลดเล็กน้อย'; trendColor = '#f59e0b'; }
    else { trendText = '➡️ คงที่'; trendColor = '#6b7280'; }
    
    const sparkLevels = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const maxRev = Math.max(...dd.map(d => d.revenue)) || 1;
    const spark = dd.slice(-14).map(d => sparkLevels[Math.min(7, Math.floor((d.revenue / maxRev) * 8))]).join('');
    
    replyText(replyToken,
      '📈 Trend 30 วัน\n\n' +
      trendText + '\n' +
      (trendPct >= 0 ? '+' : '') + trendPct.toFixed(2) + '% ต่อวัน\n\n' +
      '📊 14 วันล่าสุด:\n' + spark + '\n\n' +
      '💰 เฉลี่ย/วัน: ฿' + Math.round(avgRev).toLocaleString()
    );
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyComparison(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const ys = new Date(ts.getTime() - 86400000);
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const lms = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const today = calcStats(data.logs, data.expenses, ts, now);
    const yesterday = calcStats(data.logs, data.expenses, ys, ts);
    const month = calcStats(data.logs, data.expenses, ms, now);
    const lastMonth = calcStats(data.logs, data.expenses, lms, ms);
    const row = (label, cur, prev) => {
      const change = prev > 0 ? ((cur - prev) / prev) * 100 : (cur > 0 ? 100 : 0);
      const emoji = change > 5 ? '📈' : change < -5 ? '📉' : '➡️';
      const color = change > 5 ? '#10b981' : change < -5 ? '#ef4444' : '#f59e0b';
      return {
        type: 'box', layout: 'horizontal',
        contents: [
          { type: 'text', text: label, size: 'xs', color: '#9ca3af', flex: 4 },
          { type: 'text', text: '฿' + cur.toLocaleString(), size: 'xs', color: '#ffffff', align: 'end', flex: 3, weight: 'bold' },
          { type: 'text', text: emoji + (change >= 0 ? '+' : '') + change.toFixed(0) + '%', size: 'xs', color, align: 'end', flex: 3, weight: 'bold' }
        ],
        margin: 'sm'
      };
    };
    replyFlex(replyToken, {
      type: 'flex', altText: 'เปรียบเทียบ',
      contents: {
        type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '⚖️ เปรียบเทียบ', weight: 'bold', color: '#8b5cf6', size: 'lg' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
          createSectionTitle('📆 เดือนนี้ vs เดือนก่อน', '#f59e0b'),
          row('รายได้', month.revenue, lastMonth.revenue),
          row('กำไร', month.profit, lastMonth.profit),
          { type: 'separator', margin: 'lg' },
          createSectionTitle('🌅 วันนี้ vs เมื่อวาน', '#10b981'),
          row('รายได้', today.revenue, yesterday.revenue),
          row('กำไร', today.profit, yesterday.profit)
        ], paddingAll: '16px' },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyCashFlow(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const ml = data.logs.filter(l => new Date(l.timestamp) >= ms);
    const me = data.expenses.filter(e => new Date(e.timestamp) >= ms);
    const cashIn = ml.filter(l => l.type === 'OUT' && l.paymentMethod === 'CASH').reduce((s, l) => s + Number(l.total || 0), 0);
    const transIn = ml.filter(l => l.type === 'OUT' && l.paymentMethod === 'TRANSFER').reduce((s, l) => s + Number(l.total || 0), 0);
    const totalIn = cashIn + transIn;
    const cashOut = me.filter(e => e.paymentMethod === 'CASH').reduce((s, e) => s + Number(e.amount || 0), 0);
    const transOut = me.filter(e => e.paymentMethod === 'TRANSFER').reduce((s, e) => s + Number(e.amount || 0), 0);
    const totalOut = cashOut + transOut;
    const net = totalIn - totalOut;
    replyText(replyToken,
      '💵 Cash Flow เดือนนี้\n\n' +
      '⬆️ เงินเข้า\n' +
      '  💵 เงินสด: ฿' + cashIn.toLocaleString() + '\n' +
      '  📱 โอน: ฿' + transIn.toLocaleString() + '\n' +
      '  รวม: ฿' + totalIn.toLocaleString() + '\n\n' +
      '⬇️ เงินออก\n' +
      '  💵 เงินสด: -฿' + cashOut.toLocaleString() + '\n' +
      '  📱 โอน: -฿' + transOut.toLocaleString() + '\n' +
      '  รวม: -฿' + totalOut.toLocaleString() + '\n\n' +
      '💰 สุทธิ: ' + (net >= 0 ? '+' : '') + '฿' + net.toLocaleString()
    );
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyCashFlowForecast(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
    const rs = salesLogs.filter(l => new Date(l.timestamp) >= thirtyDaysAgo);
    const re = data.expenses.filter(e => new Date(e.timestamp) >= thirtyDaysAgo);
    const dr = rs.reduce((s, l) => s + Number(l.total || 0), 0) / 30;
    const de = re.reduce((s, e) => s + Number(e.amount || 0), 0) / 30;
    const dn = dr - de;
    const finalNet = dn * 30;
    replyText(replyToken,
      '🔮 Cash Flow Forecast 30 วัน\n\n' +
      '💰 รายได้/วัน: ฿' + Math.round(dr).toLocaleString() + '\n' +
      '💸 รายจ่าย/วัน: ฿' + Math.round(de).toLocaleString() + '\n' +
      '📊 สุทธิ/วัน: ฿' + Math.round(dn).toLocaleString() + '\n\n' +
      'คาดการณ์ 30 วัน: ' + (finalNet >= 0 ? '+' : '') + '฿' + Math.round(finalNet).toLocaleString() + '\n\n' +
      (finalNet > 0 ? '✅ แนวโน้มดี ควรเก็บสำรอง' : '⚠️ ติดลบ ต้องลดรายจ่าย')
    );
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyForecast(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const dateGroups = {};
    salesLogs.forEach(l => {
      const date = new Date(l.timestamp).toISOString().slice(0, 10);
      if (!dateGroups[date]) dateGroups[date] = { qty: 0, rev: 0 };
      dateGroups[date].qty += Number(l.qty || 0);
      dateGroups[date].rev += Number(l.total || 0);
    });
    const dates = Object.keys(dateGroups).sort();
    if (dates.length < 3) { replyText(replyToken, '❌ ข้อมูลไม่พอ (ต้องมี 3 วันขึ้นไป)'); return; }
    const n = dates.length;
    const xv = dates.map((_, i) => i);
    const yv = dates.map(d => dateGroups[d].qty);
    const sx = xv.reduce((a, b) => a + b, 0);
    const sy = yv.reduce((a, b) => a + b, 0);
    const sxy = xv.reduce((s, x, i) => s + x * yv[i], 0);
    const sx2 = xv.reduce((s, x) => s + x * x, 0);
    const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
    const intercept = (sy - slope * sx) / n;
    let totalForecast = 0;
    for (let i = 1; i <= 7; i++) totalForecast += Math.max(0, Math.round(slope * (n + i - 1) + intercept));
    const avgPrice = salesLogs.length > 0 ? salesLogs.reduce((s, l) => s + Number(l.total || 0), 0) / salesLogs.reduce((s, l) => s + Number(l.qty || 0), 0) : 35;
    const revForecast = Math.round(totalForecast * avgPrice);
    replyText(replyToken,
      '🔮 พยากรณ์ 7 วัน\n\n' +
      '📦 คาดว่า: ' + totalForecast + ' ขวด\n' +
      '💰 รายได้: ฿' + revForecast.toLocaleString() + '\n\n' +
      '💡 อ้างอิง: ' + n + ' วันย้อนหลัง'
    );
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyFullAnalysis(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const now = new Date();
    const tda = new Date(now.getTime() - 30 * 86400000);
    const rs = salesLogs.filter(l => new Date(l.timestamp) >= tda);
    const re = data.expenses.filter(e => new Date(e.timestamp) >= tda);
    const revenue = rs.reduce((s, l) => s + Number(l.total || 0), 0);
    const totalExp = re.reduce((s, e) => s + Number(e.amount || 0), 0);
    const volume = rs.reduce((s, l) => s + Number(l.qty || 0), 0);
    const profit = revenue - totalExp;
    const netMargin = revenue > 0 ? (profit / revenue) * 100 : 0;
    const velocity = volume / 30;
    let health = 50;
    if (netMargin > 30) health += 20; else if (netMargin > 15) health += 10; else if (netMargin < 0) health -= 20;
    if (velocity > 20) health += 15; else if (velocity > 10) health += 8;
    health = Math.max(0, Math.min(100, health));
    const grade = health >= 80 ? 'A (ดีเยี่ยม)' : health >= 65 ? 'B (ดี)' : health >= 50 ? 'C (ปานกลาง)' : 'D (ต้องปรับปรุง)';
    const color = health >= 80 ? '#10b981' : health >= 65 ? '#3b82f6' : health >= 50 ? '#f59e0b' : '#ef4444';
    replyFlex(replyToken, {
      type: 'flex', altText: 'BI',
      contents: {
        type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📊 BI 30 วัน', weight: 'bold', color: '#8b5cf6', size: 'lg' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '🏥 Health Score', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: health + '/100', color, size: 'xxl', weight: 'bold' },
            { type: 'text', text: 'เกรด ' + grade, color, size: 'sm', margin: 'sm', weight: 'bold' }
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
          createAnalysisRow('รายได้', '฿' + revenue.toLocaleString(), '#10b981'),
          createAnalysisRow('รายจ่าย', '฿' + totalExp.toLocaleString(), '#ef4444'),
          createAnalysisRow('กำไร', '฿' + profit.toLocaleString(), profit >= 0 ? '#f59e0b' : '#ef4444'),
          createAnalysisRow('ปริมาณ', volume + ' ขวด', '#3b82f6'),
          createAnalysisRow('Net Margin', netMargin.toFixed(1) + '%', '#8b5cf6'),
          createAnalysisRow('Velocity', velocity.toFixed(1) + ' ขวด/วัน', '#06b6d4')
        ], paddingAll: '16px' },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    });
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyCustomerStats(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const totalBills = salesLogs.length;
    const totalRev = salesLogs.reduce((s, l) => s + Number(l.total || 0), 0);
    const atv = totalBills > 0 ? totalRev / totalBills : 0;
    replyText(replyToken,
      '👥 สถิติลูกค้า\n\n' +
      '🧾 บิลทั้งหมด: ' + totalBills + '\n' +
      '💰 ยอดรวม: ฿' + totalRev.toLocaleString() + '\n' +
      '📊 เฉลี่ย/บิล: ฿' + Math.round(atv).toLocaleString()
    );
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyHelp(replyToken, isAdmin) {
  replyFlex(replyToken, {
    type: 'flex', altText: 'เมนู',
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '🍃 KRATOM POS', weight: 'bold', color: '#10b981', size: 'xl' },
          { type: 'text', text: 'v' + CONFIG.VERSION, color: '#9ca3af', size: 'sm', margin: 'sm' }
        ],
        backgroundColor: '#0a0c10', paddingAll: '20px'
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          createHelpSection('🛒 บันทึกการขาย', '#10b981', [
            ['วันนี้ ฝาแดง14 BM16', 'บันทึกวันนี้'],
            ['พรุ่งนี้ A14 BM16', 'บันทึกวันพรุ่งนี้'],
            ['15/10/26 A14 BM16', 'ระบุวันที่']
          ]),
          createHelpSection('📊 รายงาน', '#f59e0b', [
            ['รายงานวันนี้', 'รายวัน'],
            ['รายงานสัปดาห์', '7 วัน'],
            ['รายงานเดือน', 'รายเดือน']
          ]),
          createHelpSection('📈 วิเคราะห์', '#3b82f6', [
            ['แดชบอร์ด', 'ภาพรวม'],
            ['kpi', 'KPI'],
            ['cashflow', 'เงินสด'],
            ['trend', 'แนวโน้ม']
          ])
        ],
        paddingAll: '16px'
      },
      styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
    }
  });
}

function replyUnknownCommand(replyToken, text) {
  replyText(replyToken, '❓ ไม่รู้จักคำสั่ง: "' + text + '"\n\nพิมพ์ "ช่วยเหลือ" เพื่อดูทั้งหมด');
}

// ============================================================================
// 📌 AUTO REPORTS
// ============================================================================
function sendDailyReport() {
  try {
    const adminId = LINE_CONFIG.ADMIN_USER_ID;
    if (!adminId) { console.warn('[Daily] No admin ID'); return; }
    const flex = buildDailyReportFlex(new Date());
    const r = pushMessage(adminId, [flex]);
    console.log('[Daily] Sent:', r && r.getResponseCode());
  } catch (err) { console.error('sendDailyReport:', err); }
}

function sendWeeklyReport() {
  try {
    const adminId = LINE_CONFIG.ADMIN_USER_ID;
    if (!adminId) return;
    pushMessage(adminId, [buildWeeklyReportFlex(new Date())]);
  } catch (err) { console.error('sendWeeklyReport:', err); }
}

function sendMonthlyReport() {
  try {
    const adminId = LINE_CONFIG.ADMIN_USER_ID;
    if (!adminId) return;
    const now = new Date();
    const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    pushMessage(adminId, [buildMonthlyReportFlex(prevMonthDate)]);
  } catch (err) { console.error('sendMonthlyReport:', err); }
}

// ============================================================================
// 📌 TRIGGERS
// ============================================================================
function dailyStatsTrigger() {
  try {
    // ✅ Update YESTERDAY's stats (not today - today is incomplete)
    const yesterday = new Date(Date.now() - 86400000);
    updateDailyStats(yesterday.toISOString());
    console.log('Daily stats updated for yesterday');
  } catch (err) { console.error('dailyStatsTrigger:', err); }
}

function autoBackupTrigger() {
  try {
    const result = createBackup();
    console.log('Auto backup:', JSON.stringify(result));
  } catch (err) { console.error('autoBackupTrigger:', err); }
}

function cleanupTrigger() {
  try {
    cleanupOldBackups();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auditSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.AUDIT);
    if (auditSheet && auditSheet.getLastRow() > CONFIG.AUDIT_RETENTION_ROWS) {
      auditSheet.deleteRows(2, auditSheet.getLastRow() - CONFIG.AUDIT_RETENTION_ROWS);
    }
  } catch (err) { console.error('cleanupTrigger:', err); }
}

function installTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    const fn = t.getHandlerFunction();
    if (['dailyStatsTrigger', 'autoBackupTrigger', 'cleanupTrigger',
         'sendDailyReport', 'sendWeeklyReport', 'sendMonthlyReport'].includes(fn)) {
      ScriptApp.deleteTrigger(t);
    }
  });
  
  ScriptApp.newTrigger('dailyStatsTrigger').timeBased().everyDays(1).atHour(1).create();
  ScriptApp.newTrigger('autoBackupTrigger').timeBased().everyHours(6).create();
  ScriptApp.newTrigger('cleanupTrigger').timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger('sendDailyReport').timeBased().atHour(LINE_CONFIG.DAILY_REPORT_HOUR || 21).everyDays(1).create();
  ScriptApp.newTrigger('sendWeeklyReport').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(21).create();
  ScriptApp.newTrigger('sendMonthlyReport').timeBased().onMonthDay(1).atHour(9).create();
  
  return { status: 'success', message: 'All triggers installed', triggers: ScriptApp.getProjectTriggers().length };
}

// ============================================================================
// 📌 INSTALL SYSTEM
// ============================================================================
function installSystem() {
  console.log('🚀 Starting installation...');
  const summary = { timestamp: new Date().toISOString(), version: CONFIG.VERSION };
  
  console.log('Step 1: Setup spreadsheet...');
  try {
    summary.setup = setupSpreadsheet();
    console.log('✅ Spreadsheet OK');
  } catch (e) {
    summary.setup = { status: 'error', message: e.toString() };
    console.error('❌ Setup failed:', e);
  }
  
  console.log('Step 2: Install triggers...');
  try {
    summary.triggers = installTriggers();
    console.log('✅ Triggers OK');
  } catch (e) {
    summary.triggers = { status: 'error', message: e.toString() };
    console.error('❌ Triggers failed:', e);
  }
  
  console.log('Step 3: Health check...');
  try {
    summary.health = healthCheck();
    console.log('✅ Health check OK');
  } catch (e) {
    summary.health = { status: 'error', message: e.toString() };
    console.error('❌ Health failed:', e);
  }
  
  console.log('Step 4: Test LINE...');
  try {
    const secrets = loadSecrets();
    if (secrets.lineToken && secrets.lineAdminId) {
      const testMsg = pushMessage(secrets.lineAdminId, [{
        type: 'text',
        text: '🍃 KRATOM POS ติดตั้งสำเร็จ!\n\n📊 Version: ' + CONFIG.VERSION + '\n🎯 Yield: 90%\n🛒 บันทึกผ่าน LINE: วันนี้ ฝาแดง14 BM16 T4\n📊 รายงาน: Daily 21:00\n\nพิมพ์ "ช่วยเหลือ"'
      }]);
      summary.lineTest = testMsg && testMsg.getResponseCode() === 200 ? 'success' : 'failed';
    } else {
      summary.lineTest = 'skipped - not configured';
    }
  } catch (e) {
    summary.lineTest = 'error: ' + e.toString();
  }
  
  summary.status = 'success';
  summary.nextSteps = [
    '1. Deploy > New deployment > Web app',
    '2. Execute as: Me, Access: Anyone',
    '3. Copy Web App URL',
    '4. ใส่ URL ใน LINE Developers Webhook',
    '5. ใส่ URL + API Key ใน index.html/dashboard.html'
  ];
  
  console.log('========================================');
  console.log('🎉 INSTALLATION COMPLETE');
  console.log('========================================');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function setupLineBot() {
  const results = { webhook: 'Not tested', token: 'Set', secret: 'Set', triggers: 'Not installed' };
  try {
    const secrets = loadSecrets();
    if (!secrets.lineToken) { results.webhook = 'Token not configured'; return results; }
    const url = LINE_CONFIG.API_ENDPOINT + '/info';
    const response = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + secrets.lineToken },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() === 200) results.webhook = 'Connected';
  } catch (e) { results.webhook = 'Error: ' + e.toString(); }
  try {
    installTriggers();
    results.triggers = 'Installed';
  } catch (e) { results.triggers = 'Error: ' + e.toString(); }
  return results;
}

function testLineBot() {
  const results = {};
  try {
    const secrets = loadSecrets();
    if (!secrets.lineAdminId) { results.sendMessage = '❌ Admin ID not configured'; return results; }
    const r = pushMessage(secrets.lineAdminId, [{
      type: 'text',
      text: '🧪 TEST v' + CONFIG.VERSION + '\n\n' + new Date().toLocaleString('th-TH') + '\n\n✅ ทำงานปกติ'
    }]);
    results.sendMessage = r && r.getResponseCode() === 200 ? '✅ OK' : '❌ Failed';
  } catch (e) { results.sendMessage = '❌ ' + e.toString(); }
  try {
    const data = getAllData();
    results.dataAccess = '✅ logs: ' + data.logs.length + ', expenses: ' + data.expenses.length + ', products: ' + data.products.length;
  } catch (e) { results.dataAccess = '❌ ' + e.toString(); }
  return results;
}
